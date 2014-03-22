angular.module( 'OctoBinder', [] )
	.factory('obBinder',
	[
	'$parse', '$q', 'obBinderTypes', 'obModelWriter', 'obObserver',
	function ( $parse, $q, obBinderTypes, obModelWriter, obObserver ) {
		function Binder( scope, model, protocol, options ) {
			options = options || {};

			if ( !protocol ) throw new Error( 'protocol is required' );
			if ( !scope ) throw new Error( 'scope is required' );
			if ( !model ) throw new Error( 'model is required' );

			if ( options.key && typeof options.key !== 'string' ) {
				throw new Error( 'key must be a string' );
			}

			this.protocol = protocol;

			this.scope = scope;
			this.model = model;
			this.query = options.query;
			this.type  = options.type;
			this.key   = options.key;

			this.ignoreNModelChanges    = 0;
			this.ignoreNProtocolChanges = 0;

			this.bindModel( this.type, scope, model );

			this.protocol.subscribe( this );
		}

		Binder.prototype.bindModel = function ( type, scope, model ) {
			switch ( type ) {
				case obBinderTypes.COLLECTION:
				case obBinderTypes.OBJECT:
					this.observer = obObserver.observeCollection( this, scope[model], this.onModelChange );

					break;
			}
		};

		Binder.prototype.onModelChange = function ( changes ) {
			var numAffectedItems = 0,
				delta = { changes: changes },
				defer = $q.defer();

			for ( var i = 0; i < changes.length; i++ ) {
				if (changes.name && 1) {
					numAffectedItems++;
				} else {
					numAffectedItems += changes[i].addedCount + (changes[i].removed && changes[i].removed.length) || 0;
				}
			}

			if ( !delta.changes.length ) {
				defer.resolve();
			} else {
				if ( this.ignoreNModelChanges ) {
					this.ignoreNModelChanges -= numAffectedItems;

					defer.resolve();
				} else if (numAffectedItems) {
					this.protocol.processChanges( this, delta )
						.then(function(){ defer.resolve(); });
				}
			}

			return defer.promise;
		};

		Binder.prototype.onProtocolChange = function ( changes ) {
			var delta = { changes: changes },
				defer = $q.defer();

			if ( !changes.length ) {
				defer.resolve();
			} else {
				if ( this.ignoreNProtocolChanges ) {
					var newChanges = [];

					for ( var i = 0; i < changes.length; i++ ) {
						if ( changes[i].force ) {
							newChanges.push( changes[i] );
						}

						this.ignoreNProtocolChanges--;
					}

					if ( newChanges.length ) {
						delta.changes = newChanges;
					} else {
						defer.resolve();
					}
				}

				obModelWriter.processChanges( this, delta )
					.then(function() {
						defer.resolve();
					})
			}

			return defer.promise;
		};

		Binder.prototype.val = function () {
			var getter = $parse( this.model );

			return getter( this.scope );
		};

		return function () {
			var binder = Object.create( Binder.prototype );

			Binder.apply( binder, arguments );

			return binder;
		};
	}
	]
	);

angular.module( 'OctoBinder' )
	.factory('obBinderTypes',
	[
	function () {
		return {
			COLLECTION:    'collection',
			OBJECT:        'object',
			BOOLEAN:       'boolean',
			STRING:        'string',
			NUMBER:        'number',
			BINARY:        'binary',
			BINARY_STREAM: 'binaryStream'
		};
	}
	]
	);

(function () {
	var DeltaFactory = function () {
	};

	DeltaFactory.prototype.addChange = function ( change ) {
		if ( !change.type ) throw new Error( 'Change must contain a type' );

		this.changes.push( change );
	};

	DeltaFactory.prototype.updateObject = function ( object ) {
		this.object = object;
		angular.forEach( this.changes, function ( change, i, list ) {
			list[i].object = object;
		} );
	};

	angular.module( 'OctoBinder' )
		.factory( 'obDelta', function () {
			return function ( change ) {
				var delta = Object.create( DeltaFactory.prototype );
				DeltaFactory.call( delta );
				delta.changes = [];

				if ( change ) delta.addChange( change );

				return delta;
			};
		} );
}());

angular.module( 'OctoBinder' )
	.service('obModelWriter',
	[
	'$parse', '$q', 'obBinderTypes', 'obSyncEvents',
	function ( $parse, $q, obBinderTypes, obSyncEvents ) {
		var self = this;

		// Useful to shorten code, but should only be used for non-scalar models.
		this.applyArrayChange = function ( binder, change ) {
			var model = $parse( binder.model )( binder.scope );

			if ( change.added ) {
				var firstChange = change.added.shift();

				model.splice( change.index, change.removed ? change.removed.length : 0, firstChange );

				while ( next = change.added.shift() ) {
					change.index++;

					model.splice( change.index, 0, next );
				}
			} else {
				model.splice( change.index, change.removed ? change.removed.length : 0 );
			}

			binder.ignoreNModelChanges += (change.removed && change.removed.length || 0) + change.addedCount;

			$parse( binder.model ).assign( binder.scope, model );

			if ( !binder.scope.$$phase ) binder.scope.$apply();
		};

		this.applyObjectChange = function ( binder, change ) {
			if ( binder.key ) {
				function findObject( keyName, key ) {
					var obj;
					var collection = binder.scope[binder.model];

					angular.forEach( collection, function ( item, i ) {
						if ( obj ) return;

						if ( item[keyName] === key ) {
							obj = item;
						} else if ( typeof item[keyName] === 'undefined' ) {
							//Object does not yet have a key, let's hope the update is trying to assign the key
							obj = item;
						}
					} );

					return obj;
				}

				var obj = findObject( binder.key, change.object[binder.key] );

				if ( !obj ) throw new Error( 'Could not find object with key' + change.object[binder.key] );

				switch ( change.type ) {
					case "update":
						if ( obj[change.name] !== change.object[change.name] ) {
							binder.ignoreNModelChanges++;
						}

						obj[change.name] = change.object[change.name];

						break;
					case "delete":
						binder.ignoreNModelChanges++;

						delete obj[change.name];

						break;
					case "new":
						if ( obj[change.name] !== change.object[change.name] ) {
							binder.ignoreNModelChanges++;
						}

						obj[change.name] = change.object[change.name];
						break;
				}

				if ( !binder.scope.$$phase ) {
					binder.scope.$apply();
				}
			}

		};

		this.processChanges = function ( binder, delta ) {
			var defer = $q.defer(),
				promises = [];

			for (var i=0; i < delta.changes.length; i++) {
				switch ( binder.type ) {
					case obBinderTypes.COLLECTION:
						if ( typeof delta.changes[i].index === 'number' ) {
							promises.push(
								function() {
									self.applyArrayChange( binder, delta.changes[i] );
								}(i)
							);
						} else if ( typeof change.name === 'string' ) {
							this.applyObjectChange( binder, delta.changes[i] );

							promises.push(
								function() {
									self.applyObjectChange( binder, delta.changes[i] );
								}(i)
							);
						}

						break;
				}
			}

			$q.all(promises).then(function(){ defer.resolve(); });

			return defer.promise;
		};
	}
	]
	);

angular.module( 'OctoBinder' )
	.factory( 'obArrayChange', function () {
		return function ( addedCount, removed, index ) {
			return {
				addedCount: addedCount,
				removed:    removed,
				index:      index
			};
		};
	} )
	.factory( 'obOldObject', function () {
		return function ( change ) {
			var oldObject = angular.copy( change.object );

			oldObject[change.name] = change.oldValue;

			return oldObject;
		};
	} )
	.service( 'obObserver',
		[
		'obArrayChange', 'obOldObject', '$q',
		function ( obArrayChange, obOldObject, $q ) {
			this.observeObjectInCollection = function ( context, collection, object, callback ) {
				function onObjectObserved( added, removed, changed, getOldValueFn ) {
					var changes = [
						{
							added:   added,
							removed: removed,
							changed: changed,
							index:   getOldValueFn( context.key )
						}
					];

					var splices = [];

					function pushSplice( change ) {
						var oldObject = obOldObject( change ),
							index = collection.indexOf( change.object );

						splices.push( obArrayChange(1, [oldObject], index) );
					}

					if ( !context.key ) {
						angular.forEach( changes, pushSplice );

						callback.call( context, splices );
					} else {
						callback.call( context, changes );
					}
				}

				this.observers[object] = new ObjectObserver( object, onObjectObserved );
			};

			this.observers = {};

			this.observeCollection = function ( context, collection, callback ) {
				var self = this,
					observer;

				angular.forEach( collection, observeOne );

				observer = new ArrayObserver( collection, onArrayChange );

				return observer;

				function observeOne( obj ) {
					self.observeObjectInCollection( context, collection, obj, callback );
				}

				function onArrayChange( changes ) {
					angular.forEach( changes, watchNewObjects );

					callback.call( context, changes );
				}

				function watchNewObjects( change ) {
					var i = change.index;
					var lastIndex = change.addedCount + change.index;

					while ( i < lastIndex ) {
						observeOne( collection[i] );
						i++;
					}

					if ( change.removed.length ) {
						// Unobserve each item
						angular.forEach( change.removed, function unObserve( obj ) {
							self.observers[obj].close();
						} );
					}
				}
			};
		}
		]
	);

angular.module( 'OctoBinder' )
	.value( 'obSyncEvents', {
		//Standard Object.observe change events
		NEW:          'new',
		UPDATED:      'update',
		DELETED:      'deleted',
		RECONFIGURED: 'reconfigured',
		//End standard Object.observe change events.
		//Used for initial synchronization of data from protocol.
		READ:         'read',
		MOVE:         'move',
		NONE:         'none',
		INIT:         'init',
		UNKNOWN:      'unknown'
	} );
