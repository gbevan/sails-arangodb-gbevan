/*jshint node: true, esversion:6 */
'use strict';

/*global console, process*/
var Arango = require('arangojs'),
    Q = require('q'),
    async = require('async'),
    _ = require('lodash'),
    aqb = require('aqb'),
    debug = require('debug')('sails-arangodb:connection');

debug.log = console.log.bind(console);

/**
 *
 * @module
 * @name connection
 */
module.exports = (function() {

  var serverUrl = '';
  var defaults = {
    createCustomIndex: false,
    idProperty: 'id',
    caseSensitive: false
  };

  var server;

  var DbHelper = function(db, graph, collections, config) {
    this.db = db;
    this.graph = graph;
    this.collections = collections;
    this.config = _.extend(config, defaults);
  };

  /**
   * Connect to ArangoDB and use the requested database or '_system'
  */
  var getDb = function(connection) {
    debug('getDB() connection:', connection);
    var userpassword = '';
    /* istanbul ignore next */
    if (connection.user && connection.password) {
      userpassword = connection.user + ':' + connection.password + '@';
    }

    serverUrl = 'http://' + userpassword + connection.host + ':' + connection.port;
    /* istanbul ignore next */
    if (!server) {
      server = new Arango({
        url: serverUrl,
        databaseName: connection.database || '_system'
      });
    }
    return server;
  };

  var getGraph = function(db, connection) {
    debug('getGraph() connection.graph:', connection.graph);
    return db.graph(connection.graph);
  };

  var getCollection = function(db, connection) {
    return db.collection(connection.collection);
  };

  DbHelper.logError = function(err) {
    console.error(err.stack);
  };

  DbHelper.prototype.db = null;
  DbHelper.prototype.graph = null;
  DbHelper.prototype.collections = null;
  DbHelper.prototype.config = null;
  DbHelper.prototype._classes = null;

  DbHelper.prototype.getClass = function(collection) {
    return this._classes[collection];
  };

  DbHelper.prototype.ensureIndex = function() {
    // to be implemented?
  };

  /*Makes sure that all the collections are synced to database classes*/
  DbHelper.prototype.registerCollections = function() {
    var deferred = Q.defer();
    var me = this;
    var db = me.db;
    var graph = me.graph;
    var collections = this.collections;

    async.auto({
        ensureDB: function(next) {
          debug('ensureDB()');
          var system_db = Arango({
            url: serverUrl,
            databaseName: '_system'
          });
          system_db.listDatabases(function(err, dbs) {
            if (err) {
              DbHelper.logError(err);
              process.exit(1);
            }

            // Create the DB if needed
            if (dbs.indexOf(db.name) === -1) {
              system_db.createDatabase(db.name, function(err, result) {
                if (err) {
                  DbHelper.logError(err);
                  process.exit(1);
                }
                debug('Created database: ' + db.name);
                next(null, db.name);
              });
            }
            else {
              next(null, db.name);
            }
          });
        },

        // Get collections from DB
        getCollections: ['ensureDB', function(next) {
          debug('getCollections()');
          db.collections(function(err, cols) {
            if (err){
              DbHelper.logError(err);
              process.exit(1);
            }
            var docCollection = cols.filter(function(c){
              if (c.type == 2){ // @TODO: Use something like ArangoDB.EDGE_COLLECTION
                                // see https://github.com/gabriel-letarte/arangojs/blob/master/src/collection.js
                                // export const types = {
                                //   DOCUMENT_COLLECTION: 2,
                                //   EDGE_COLLECTION: 3
                                // };
                return c;
              }
            });
            var edgeCollection = cols.filter(function(c){
              if (c.type == 3){ // @TODO: see above
                return c;
              }
            });
            next(null, {
              'docCollection': docCollection,
              'edgeCollection': edgeCollection,
            });
          });
        }],

        /**
         * Get all existing named graphs
         */
        getNamedGraphs: ['ensureDB', function (next) {
          debug('getNamedGraphs');
          db.listGraphs()
          .then((graphs) => {
            debug('graphs:', graphs);
            let graphs_hash = {};
            graphs.forEach((g) => {
              graphs_hash[g._key] = g;
            });
            next(null, graphs_hash);
          })
          .catch((err) => {
            next(err);
          });
        }],

        // Get relations from DB
        getEdgeCollections: ['ensureDB', function(next) {
          debug('getEdgeCollections()');
          var edgeCollections = [];
          _.each(collections, function(v, k) {
            _.each(v.attributes, function(vv, kk) {
              if (vv.edge) {
                vv.from = v.tableName;
                edgeCollections.push(vv);
              }
            });
          });
          next(null, edgeCollections);
        }],

        createMissingCollections: ['getCollections', function(next, results) {
          debug('createMissingCollections()');
          var currentCollections = results.getCollections.docCollection;
          var missingCollections = _.filter(collections, function(v, k) {
            debug('createMissingCollections edgeDefinitions:', v.adapter.query._attributes.$edgeDefinitions);
            debug('createMissingCollections hasSchema:', v.adapter.query.hasSchema);
            return _.find(currentCollections, function(klass) {
              return v.adapter.collection == klass.name;
            }) === undefined && (
              !v.adapter.query.attributes ||
              !v.adapter.query.attributes.$edgeDefinitions
            );
          });
          if (missingCollections.length > 0) {
            async.mapSeries(missingCollections,
              function(collection, cb) {
                debug('db.collection - CALLED', collection.adapter.collection, 'junctionTable:', collection.meta.junctionTable);
                db.collection(collection.adapter.collection).create(function(err){
                  if (err) {
                    debug('err:', err);
                    return cb(err, null);
                  }
                  debug('db.collection - DONE');
                  return cb(null, collection);
                });
              },
              function(err, created) {
                next(err, created);
              });
          } else {
            next(null, []);
          }
        }],

        /**
         * Create any missing Edges
         */
        createMissingEdges: ['getCollections', 'getEdgeCollections', function(next, results) {
          debug('createMissingEdges()');
          var classes = results.getCollections;
          async.mapSeries(results.getEdgeCollections,
            function(collection, cb) {
              if (!_.find(classes, function(v) {
                  return (v == collection.edge);
                })) {
                debug('db.edgeCollection - CALLED', collection.edge);
                db.edgeCollection(collection.edge).create(function(results){
                  debug('db.edgeCollection - DONE');
                  return cb(null, collection);
                });
              }
              return cb(null, null);
            },
            function(err, created) {
              next(err, created);
            });
        }],

        /**
         * Create any missing Named Graphs
         */
        createMissingNamedGraph: ['createMissingCollections', 'getNamedGraphs', function (next, results) {
          const currentNamedGraphs = results.getNamedGraphs;
          debug('createMissingNamedGraph currentNamedGraphs:', currentNamedGraphs);
          const missingNamedGraphs = {};
          _.each(collections, (v, k) => {
            debug('createMissingNamedGraph hasSchema:', v.adapter.query.hasSchema, 'k:', k);
            if (currentNamedGraphs[k] === undefined &&
                v.adapter.query.attributes &&
                v.adapter.query.attributes.$edgeDefinitions
               ) {
              missingNamedGraphs[k] = v;
            }
          });

          const promises = [];
          _.each(missingNamedGraphs, (g, k) => {
            promises.push(me.createGraph(db, k, g.attributes.$edgeDefinitions));
          });
          Q.all(promises)
          .then((r) => {
            next(null, r);
          })
          .fail((err) => {
            next(err);
          });
        }],

        addVertexCollections: ['createMissingCollections', function(next, results) {
          debug('addVertexCollections()');
          async.mapSeries(results.createMissingCollections,
            function(collection, cb) {
              graph.addVertexCollection(collection.tableName, function() {
                return cb(null, collection);
              });
            },
            function(err, created) {
              next(null, results);
            });
        }],

        addEdgeDefinitions: ['addVertexCollections', 'createMissingEdges', function(complete, results) {
          debug('addEdgeDefinitions()');
          async.mapSeries(results.getEdgeCollections,
            function(edge, cb) {
              graph.addEdgeDefinition({
                from: [edge.from],
                collection: edge.edge,
                to: [edge.collection]
              }, function() {
                cb(null, edge);
              });
            },
            function(err, created) {
              complete(null, results);
            });
        }]
      },
      function(err, results) {
        if (err) {
          debug('ASYNC.AUTO - err:', err);
          deferred.reject(err);
          return;
        }
        debug('ASYNC.AUTO - DONE results:', results);

        deferred.resolve(results.createMissingCollections);

      });

    return deferred.promise;
  };

  DbHelper.prototype.quote = function(val) {
    return aqb(val).toAQL();
  };

  /**
   * @function
   * @name query
   * Send an AQL query to Arangodb
   * @param   {string}   collectionName Name of the collection
   * @param   {string}   query          AQL Query
   * @param   {function} cb             callback
   * @returns {promise}
   */
  DbHelper.prototype.query = function(collection, query, cb) {
    debug('query() ', query);
    return new Promise((resolve, reject) => {
      this.db.query(query, function(err, cursor) {
        if (err) {
          reject(err);
          if (cb) cb(err);
          return ;
        }
        cursor.all(function(err, vals) {
          if (err) {
            reject(err);
            if (cb) cb(err);
            return;
          }
          resolve(vals);
          if (cb) cb(null, vals);
          return;
        });
      });
    });
  };

  DbHelper.prototype.getDB = function(cb) {
    var db = this.db;
    return cb(db);
  };

  /**
   * Escape regex chars for LIKE to support waterline tests
   */
  DbHelper.prototype._escapeReChars = function (s) {
    return s.replace(/[*.+?{}\[\]^$]/g, '\\$&');
  };

  DbHelper.prototype.optionsToQuery = function(collection, options, qb) {
    var self = this;

    debug('optionsToQuery() options:', options);
    qb = qb ? qb : aqb.for('d').in(collection);


    function buildWhere(where, recursed) {
      debug('buildWhere where:', where, 'recursed:', recursed);

      var outer_i = 0;
      _.each(where, function(v, k) {

        if (outer_i > 0) {
          if (whereStr !== '') whereStr += ` && `;
        }
        outer_i += 1;

        // handle or: [{field1: 'value', field2: 'value'}, ...]
        if (k === 'or') {
          if (_.isArray(v)) {
            whereStr += `${recursed ? '&&' : ''} (`;
            _.each(v, function (v_element, i_element) {
              if (i_element > 0) {
                whereStr += ' || ';
              }
              buildWhere(v_element, true, i_element);
            });
            whereStr += ')';
            return;
          }
        }

        // like as keyword
        if (k === 'like') {
          k = Object.keys(v)[0];
          v = { 'like': v[k] };
        }

        // Handle filter operators
        debug('options.where before operators: k:', k, 'v:', typeof v, v);
        var operator = '==';
        var eachFunction = '';
        var skip = false;
        var pre = '';

        // handle config default caseSensitive option
        debug('config caseSensitive:', self.config.caseSensitive);
        if (self.config.hasOwnProperty('caseSensitive')) {
          if (!self.config.caseSensitive) {
            eachFunction = 'LOWER';
          } else {
            eachFunction = '';
          }
        }

        if (v && typeof v === 'object') {
          // handle array of values for IN
          if (_.isArray(v)) {
            operator = 'IN';
            eachFunction = '';
          } else {
            // Handle filter's options

            debug('v caseSensitive:', v.caseSensitive);
            if (v.hasOwnProperty('caseSensitive')) {
              if (!v.caseSensitive) {
                eachFunction = 'LOWER';
              } else {
                eachFunction = '';
              }
              delete v.caseSensitive;
            }

            _.each(v, (vv, kk) => {
              debug('optionsToQuery kk:', kk, 'vv:', typeof vv, vv);
              v = vv;
              switch(kk) {
                case 'contains':
                  operator = 'LIKE';
                  v = `%${self._escapeReChars(vv)}%`;
                  break;

                case 'like':
                  operator = 'LIKE';
                  v = `%${self._escapeReChars(vv)}%`;
                  break;

                case 'startsWith':
                  operator = 'LIKE';
                  v = `${vv}%`;
                  break;

                case 'endsWith':
                  operator = 'LIKE';
                  v = `%${vv}`;
                  break;

                case 'lessThanOrEqual':
                case '<=':
                  operator = '<=';
                  pre = `HAS(d, "${k}") AND`;
                  break;

                case 'lessThan':
                case '<':
                  operator = '<';
                  pre = `HAS(d, "${k}") AND`;
                  break;

                case 'greaterThanOrEqual':
                case '>=':
                  operator = '>=';
                  break;

                case 'greaterThan':
                case '>':
                  operator = '>';
                  break;

                case 'not':
                case '!':
                  if (_.isArray(vv)) {  // in waterline v0.11/12
                    operator = 'NOT IN';
                    eachFunction = '';
                  } else {
                    operator = '!=';
                  }
                  break;

                case 'nin':   // in waterline master (upcoming)
                  operator = 'NOT IN';
                  eachFunction = '';
                  break;

                default:
                  const newWhere = {};
                  newWhere[`${k}.${kk}`] = vv;
                  buildWhere(newWhere, true);  // recursive for next level
                  skip = true;
              }
            });
          }
        }

        if (skip) {
          return; // to outer each() loop
        }

        switch (k) {
          case 'id':
            whereStr += `${eachFunction}(d._key) ${operator} ${eachFunction}(${aqb(v).toAQL()})`;
            break;
          case '_key':
          case '_rev':
            whereStr += `${eachFunction}(d.${k}) ${operator} ${eachFunction}(${aqb(v).toAQL()})`;
            break;
          default:
            whereStr += `(${pre} ${eachFunction}(d.${k}) ${operator} ${eachFunction}(${aqb(v).toAQL()}))`;
            break;
        }

        debug('interim whereStr:', whereStr);

      });
    } // function buildWhere

    if (options.where && options.where !== {}) {
      var whereStr = '';

      buildWhere(options.where);

      debug('whereStr:', whereStr);
      debug('qb:', qb);
      qb = qb.filter(aqb.expr('(' + whereStr + ')'));
    }

    // handle sort option
    if (options.sort && !_.isEmpty(options.sort)) {
      var sortArgs;
      debug('sort options:', options.sort);
      // as an object {'field': -1|1}
      sortArgs = _.map(options.sort, (v, k) => {
        return [`d.${k}`, `${v < 0 ? 'DESC' : 'ASC'}`];
      });

      // force consistent results
      sortArgs.push(['d._key', 'ASC']);

      sortArgs = _.flatten(sortArgs);

      debug('sortArgs:', sortArgs);
      qb = qb.sort.apply(qb, sortArgs);
    }

    if (options.limit !== undefined) {
      qb = qb.limit((options.skip ? options.skip : 0), options.limit);
    } else if (options.skip !== undefined) {
      qb = qb.limit(options.skip, Number.MAX_SAFE_INTEGER);
    }

    debug('optionsToQuery() returns:', qb);
    return qb;
  };

    // e.g. FOR d IN userTable2 COLLECT Group="all" into g RETURN {age: AVERAGE(g[*].d.age)}
  DbHelper.prototype.applyFunctions = function (options, qb) {
    // handle functions
    var funcs = {};
    _.each(options, function (v, k) {
      if (_.includes(['where', 'sort', 'limit', 'skip', 'select', 'joins'], k)) {
        return;
      }
      funcs[k] = v;
    });
    debug('applyFunctions() funcs:', funcs);

    if (Object.keys(funcs).length === 0) {
      qb = qb.return({'d': 'd'});
      return qb;
    }

    var funcs_keys = Object.keys(funcs);
    debug('applyFunctions() funcs_keys:', funcs_keys);

    var isGroupBy = false;
    var collectObj = {};

    var retobj = {};
    funcs_keys.forEach(function(func) {
      options[func].forEach(function(field) {
        if (typeof field !== 'object') {
          if (func === 'groupBy') {
            isGroupBy = true;
            collectObj[field] = `d.${field}`;
            retobj[field] = field;
          } else {
            retobj[field] = aqb.fn(func.toUpperCase())('g[*].d.' + field);
          }
        }
      });
    });

    if (isGroupBy) {
      qb = qb.collect(collectObj).into('g');
    } else {
      qb = qb.collect('Group', '"all"').into('g');
    }

    debug('retobj:', retobj);
    qb = qb.return({'d': retobj});
    return qb;
  };

  DbHelper.prototype.find = function(collection, options, cb) {
    var me = this;
    debug('connection find() collection:', collection, 'options:', options);
    var qb = this.optionsToQuery(collection, options);
    qb = me.applyFunctions(options, qb);

    var find_query = qb.toAQL();
    debug('find_query:', find_query);

    this.db.query(find_query, function(err, cursor) {
      debug('connection find() query err:', err);
      if (err) return cb(err);

      me._filterSelected(cursor, options)
      .then((vals) => {
        debug('query find response:', vals.length, 'documents returned for query:', find_query);
        debug('vals:', vals);
        return cb(null, _.map(vals, function(item) {
          return item.d;
        }));
      })
      .catch((err) => {
        console.error('find() error:', err);
        cb(err, null);
      });
    });
  };

  //Deletes a collection from database
  DbHelper.prototype.drop = function(collection, relations, cb) {
    this.db.collection(collection).drop(cb);
  };

  /*
   * Updates a document from a collection
   */
  DbHelper.prototype.update = function(collection, options, values, cb) {
    debug('update options:', options);
    var replace = false;
    if (options.where) {
      replace = options.where.$replace || false;
      delete options.where.$replace;
    }

    if (replace) {
      // provide a new createdAt
      values.createdAt = new Date();
    }

    debug('values:', values);
    var qb = this.optionsToQuery(collection, options),
        doc = aqb(values);

    if (replace) {
      qb = qb.replace('d').with_(doc).in(collection);
    } else {
      qb = qb.update('d').with_(doc).in(collection);
    }
    var query = qb.toAQL() + ' LET modified = NEW RETURN modified';
    debug('update() query:', query);

    this.db.query(query, function(err, cursor) {
      if (err) return cb(err);
      cursor.all(function(err, vals) {
        return cb(err, vals);
      });
    });
  };

  /*
   * Deletes a document from a collection
   */
  DbHelper.prototype.destroy = function(collection, options, cb) {
    var qb = this.optionsToQuery(collection, options);
    debug('destroy() qb:', qb);
    qb = qb.remove('d').in(collection);
    this.db.query(qb.toAQL() + ' LET removed = OLD RETURN removed', function(err, cursor) {
      if (err) return cb(err);
      cursor.all(function(err, vals) {
        return cb(err, vals);
      });
    });
  };

  DbHelper.prototype._filterSelected = function(cursor, criteria) {
    // filter to selected fields
    return cursor.map((v) => {
      debug('_filterSelected v:', v);
      if (criteria.select && criteria.select.length > 0) {
        let nv = {d: {}};
        _.each(criteria.joins, function(join) {
          nv[join.alias] = v[join.alias];
        });

        ['_id', '_key', '_rev'].forEach((k) => { nv.d[k] = v.d[k]; });

        criteria.select.forEach((sk) => {
          nv.d[sk] = v.d[sk];
        });
        debug('nv:', nv);
        return nv;
      }
      return v;
    });
  };

  /*
   * Perform simple join
   */
  DbHelper.prototype.join = function(collection, criteria, cb) {
    debug('join collection:', collection, 'criteria:', criteria);
    debug('criteria.joins:', criteria.joins);
    const from = criteria.joins[0];
    const aliasAttrs = this.collections[collection]._attributes[from.alias];
    debug(`alias ${from.alias} attrs:`, aliasAttrs);

    var me = this,
        join_query;

    if (!aliasAttrs.edge) { // Standard waterline Join?
      debug('waterline join');
      var q = aqb.for(collection).in(collection);
      var mergeObj = {};
      _.each(criteria.joins, function(join) {
        q = q
        .for(join.parentKey)
        .in(join.child)
        .filter(aqb.eq(`${join.parentKey}.${join.childKey}`, `${join.parent}.${join.parentKey}`));
        mergeObj[join.parentKey] = join.parentKey;
      });
      q = q.return(aqb.MERGE(collection, mergeObj));
      var q_d = aqb.for('d').in(q);
      var q_opts = this.optionsToQuery(collection, criteria, q_d);
      join_query = me.applyFunctions(criteria, q_opts);

    } else { // graph
      debug('edge join');
      const edgeCollection = aliasAttrs.edge;
      let edgeJoin = {};

      // TODO: Use above AQB approach with edges too

      var qb = this.optionsToQuery(collection, criteria).toAQL(),
        ret = ' RETURN { "d" : d';

      _.each(criteria.joins, function(join, i) {
        debug('join each i:', i, 'join:', join);

        // skip waterline implied junction tables
        if (i % 2 === 0) { // even?
          edgeJoin = join;
          return;

        } else { // odd?
          edgeJoin.edgeChild = join.child;
        }

        var _id;
        if (criteria.where) {
          _id = criteria.where._id;  // always _id for edges
          if (!_id)
            _id = criteria.where._key;
        }
        debug('join criteria _id field:', _id);

        ret += ', "' + edgeJoin.alias + '" : (FOR ' + edgeJoin.alias + ' IN ANY ' + aqb.str(_id).toAQL() + ' ' +
          edgeCollection +
          ' OPTIONS {bfs: true, uniqueVertices: true} FILTER IS_SAME_COLLECTION("' +edgeJoin.edgeChild + '", ' + edgeJoin.alias + ') RETURN ' + edgeJoin.alias + ')';
      });
      ret += ' }';
      join_query = qb + ret;
    }

    debug('join query:', join_query);
    this.db.query(join_query, function(err, cursor) {
      if (err) return cb(err);

      debug('join() criteria.select:', criteria.select);

      me._filterSelected(cursor, criteria)
      .then((vals) => {
        debug('query join response:', vals.length,
              'documents returned for query:',
              (typeof join_query === 'string' ? join_query : join_query.toAQL()));
        debug('vals[0]:', vals[0]);
        return cb(null, _.map(vals, function(item) {
          var bo = item.d;

          if (aliasAttrs.edge) {
            _.each(criteria.joins, function(join) {
              if (!criteria.select || criteria.select.includes(join.alias)) {
                bo[join.alias] = _.map(item[join.alias], function(i) {
                  return i;
                });
              }
            });
          }
          return bo;
        }));
      })
      .catch((err) => {
        console.error('join() error:', err);
        cb(err, null);
      });

    });
  };

  /*
   * Creates edge between two vertices pointed by from and to
   */
  var toArangoRef = function(val) {
    var ret = val;
    if (typeof ret === 'object') {
      ret = ret._id.split('/', 2);
    } else {
      ret = ret.split('/', 2);
    }
    return ret;
  };

  DbHelper.prototype.createEdge = function(from, to, options, cb) {
    var src = toArangoRef(from),
      dst = toArangoRef(to),
      srcAttr;

    srcAttr = _.find(this.collections[src[0]].attributes, function(i) {
      return i.collection == dst[0];
    });

    // create edge
    this.graph.edgeCollection(srcAttr.edge,
      function(err, collection) {
        if (err) return cb(err);

        collection.save((options.data ? options.data : {}),
          src.join('/'),
          dst.join('/'),
          function(err, edge) {
            if (err) return cb(err);
            cb(null, edge);
          });
      });
  };

  /*
   * Removes edges between two vertices pointed by from and to
   */
  DbHelper.prototype.deleteEdges = function(from, to, options, cb) {
    var src = toArangoRef(from),
      dst = toArangoRef(to),
      srcAttr;

    srcAttr = _.find(this.collections[src[0]].attributes, function(i) {
      return i.collection == dst[0];
    });

    // delete edge
    this.db.collection(srcAttr.edge,
      function(err, collection) {
        if (err) return cb(err);

        collection.edges(src.join('/'), function(err, edges) {
          var dErr = err;
          if (err) return cb(err);
          _.each(edges, function(i) {
            collection.remove(i._id, function(err, edge) {
              dErr = err;
            });
          });
          if (dErr !== null) {
            return cb(dErr);
          }
          cb(null, edges);
        });
      });
  };

  /**
   * Create a named graph
   *
   * @function
   * @name createGraph
   * @param   {object}   db                 DB connection
   * @param   {string}   graphName          Graph name
   * @param   {array}    edgeDefs           Array of edge definitions
   * @param   {function} cb                 Optional Callback (err, res)
   * @returns {Promise}
   *
   * example of edgeDefs:
   * ```
   * [{
   *   collection: 'edges',
   *   from: ['start-vertices'],
   *   to: ['end-vertices']
   * }, ...]
   * ```
   */
  DbHelper.prototype.createGraph = function(db, graphName, edgeDefs, cb){
    debug('createGraph() graphName:', graphName,
          'edgeDefs:', edgeDefs,
          'cb:', cb);

    var graph = db.graph(graphName);
    return graph.create({
      edgeDefinitions: edgeDefs
    })
    .then((res) => {
      if (cb) {
        cb(null, res);
      }
      return Promise.resolve(res);
    })
    .catch((err) => {
      if (cb) {
        cb(err);
      }
      return Promise.reject(err);
    });
  };

  /**
   * Delete a named graph
   *
   * @function
   * @name createGraph
   * @param   {string}   connectionName     Connection name
   * @param   {string}   graphName          Graph name
   * @param   {boolean}  dropCollections    if true delete collections associated with the graph
   * @param   {function} cb                 Optional Callback (err, res)
   * @returns {Promise}
   */
  DbHelper.prototype.deleteGraph = function(db, graphName, dropCollections, cb){
    debug('deleteGraph() graphName:', graphName,
          'cb:', cb);

    var graph = db.graph(graphName);
    return graph.drop({
      dropCollections: (dropCollections ? true : false)
    })
    .then((res) => {
      if (cb) {
        cb(null, res);
      }
      return Promise.resolve(res);
    })
    .catch((err) => {
      if (cb) {
        cb(err);
      }
      return Promise.reject(err);
    });
  };

  var connect = function(connection, collections) {
    // if an active connection exists, use
    // it instead of tearing the previous
    // one down
    var d = Q.defer();

    try {
      var db = getDb(connection);
      var graph = getGraph(db, connection);
      var helper = new DbHelper(db, graph, collections, connection);

      helper.registerCollections().then(function(classes, err) {
        d.resolve(helper);
      });
    } catch (err) {
      console.error('An error has occured when trying to connect to ArangoDB:', err);
      d.reject(err);
      throw err;
    }
    return d.promise;
  };

  return {
    create: function(connection, collections) {
      return connect(connection, collections);
    }
  };
})();
