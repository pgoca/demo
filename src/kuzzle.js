////////////////////////kuzzle module/////////////////

window.kuzzleController = (function() {
	var
	//KUZZLE_URL = 'api.uat.kuzzle.io:7512',
		KUZZLE_URL = 'http://localhost:7512',
		CABBLE_COLLECTION_POSITIONS = 'coding-challenge-cabble-positions',
		CABBLE_COLLECTION_USERS = 'coding-challenge-cabble-users',
		CABBLE_COLLECTION_RIDES = 'coding-challenge-cabble-rides';

	//////////////////privates attributes///////////////////////
	var
		kuzzle = Kuzzle.init(KUZZLE_URL),
		refreshFilterTimer,
		positionsRoom,
		ridesRoom,
		currentRide;

	return {
		init: function() {

			console.log("##############KUZZLE initialisation START !#######################");
			return new Promise(
				function(resolve, reject) {
					// TODO: retrieve userId from localstorage
					var user = app.userController.getUser();
					if (!user.userId) {
						kuzzle.create(CABBLE_COLLECTION_USERS, user.whoami, true, function(error, response) {
							if (error) {
								console.error(error);
								reject();
							} else {
								app.userController.getUser().userId = response._id;
								app.userController.getUser().whoami._id = response._id;
								app.userController.setInLocalStorage().then(
									function() {
										app.kuzzleController.listenToRidesProposals();
										app.kuzzleController.listenToUserChange();
										console.log("##############KUZZLE initialisation END !#######################");
										resolve();
									}
								);
							}
						});
					} else {
						console.log("this");
						app.kuzzleController.listenToUserChange();
						app.kuzzleController.listenToRidesProposals();
					}
					console.log("...kuzzle controller ended");
					console.log("##############KUZZLE initialisation END !#######################");
					resolve();
				});
		},

		sendMyPosition: function() {
			var userPosition = app.gisController.getUserPosition();
			var user = app.userController.getUser();

			if (!userPosition) {
				console.log("no position for user");
				return;
			}
			if (!user.whoami.type)
				return;

			kuzzle.create(CABBLE_COLLECTION_POSITIONS, {
				userId: user.whoami._id,
				type: user.whoami.type,
				position: {
					lat: userPosition.lat,
					lon: userPosition.lng
				},
				positionsRoom: positionsRoom
			}, false);
		},

		/**
		 * - Gets the top-left and bottom-right corners coordinates from google maps
		 * - Creates a kuzzle filter including geolocalization bounding box
		 * - Unsubscribe from previous room if we were listening to one
		 * - Subscribe to kuzzle with the new filter
		 */
		refreshKuzzleFilter: function() {
			var
				bound = app.gisController.getMapBounds(),
				user = app.userController.getUser();

			if (!user.whoami.type)
				return;

			var filterUserType = user.whoami.type === 'taxi' ? 'customer' : 'taxi',
				filter = {
					and: [{
						term: {
							type: filterUserType
						}
					}, {
						geoBoundingBox: {
							position: {
								top_left: {
									lat: bound.neCorner.lat,
									lon: bound.swCorner.lng
								},
								bottom_right: {
									lat: bound.swCorner.lat,
									lon: bound.neCorner.lng
								}
							}
						}
					}]
				};

			// If a currentRide has been accepted, we only want to subscribe to the other person position
			if (currentRide) {
				//console.log("ride");
				//console.log(currentRide);
			}
			if (currentRide && currentRide.status && currentRide.status.indexOf('accepted') !== -1) {
				filter.and.push({
					term: {
						_id: user.whoami.type === 'taxi' ? currentRide.customer : currentRide.taxi
					}
				});
			}

			if (positionsRoom) {
				kuzzle.unsubscribe(positionsRoom);
			}

			positionsRoom = kuzzle.subscribe(CABBLE_COLLECTION_POSITIONS, filter, function(error, message) {
				if (error) {
					console.error(error);
					return;
				}

				if (message.action !== "create") {
					console.log("recive action " + message.action);
					console.dir(message);
				}
				if (message.action == "create") {
					var data = message.data;
					if (!data)
						data = message;

					var candidatePosition = data._source.position;
					var candidateType = data._source.type;
					var candidateId = data._source.userId;

					var userType = app.userController.getUser() && app.userController.getUser().whoami.type;

					//user has change his state between the last time he listening to ride
					if (candidateType === userType)
						return;

					app.gisController.addMarker(candidatePosition, candidateType, candidateId);
				}
			});
		},

		setUserType: function(userType) {
			//console.log("set user type " + userType);
			var refreshInterval = 5000;

			app.userController.getUser().whoami.type = userType;

			if (!userType)
				return;

			app.kuzzleController.listenToRidesProposals();

			app.userController.setInLocalStorage().then(function() {
				kuzzle.update(CABBLE_COLLECTION_USERS, app.userController.getUser().whoami);

				if (userType === 'customer') {
					refreshInterval = 6000;
				} else if (userType === 'taxi') {
					refreshInterval = 1000;
				}

				if (refreshFilterTimer) {
					clearInterval(refreshFilterTimer);
				}

				app.kuzzleController.refreshKuzzleFilter()

				refreshFilterTimer = setInterval(function() {
					app.kuzzleController.refreshKuzzleFilter()
				}.bind(this), refreshInterval);
			});
		},

		listenToUserChange: function() {
			var user = app.userController.getUser();

			if (!user.whoami.type)
				return;
			/*
						var userStatus = {terms: {type: [app.userController.getUser().whoami.type === "taxi" ? "taxi" : "customer"]	}};
						*/
			var userStatus = {
				"or": [{
					"term": {
						"type": "taxi"
					}
				}, {
					"term": {
						"type": "customer"
					}
				}]
			};

			kuzzle.subscribe(CABBLE_COLLECTION_USERS, userStatus, function(error, message) {
				if (error) {
					console.error(error);
					return false;
				}
				if (!message.action.update)
					return;

				var userChanged = message._source;
				console.log("user sub ");
				console.log(message);

				//a previous user candidate is now a concurent, we remove it from view
				if (userChanged && user.whoami.type === userChanged.type) {
					app.gisController.removeCandidate(userChanged._id);
				}

				//we where in ride with this candidate, we must break the ride
				if (currentRide && (currentRide._source.taxi === userChanged._id ||  currentRide._source.customer === userChanged._id)) {
					app.kuzzleController.finishRide();
				}

			});
		},

		listenToRidesProposals: function() {
			console.log("listen to ride");
			var
				filter = {
					and: []
				},
				rideFilter = {
					term: {}
				};

			var user = app.userController.getUser();

			if (!user.whoami.type)
				return;

			statusFilter = {
				not: {
					terms: {
						status: [
							'proposed_by_' + user.whoami.type,
							'refused_by_' + user.whoami.type,
							'accepted_by_' + user.whoami.type
						]
					}
				}
			};

			rideFilter.term[user.whoami.type] = user.whoami._id;
			filter.and = [rideFilter, statusFilter];

			if (ridesRoom) {
				kuzzle.unsubscribe(ridesRoom);
			}

			ridesRoom = kuzzle.subscribe(CABBLE_COLLECTION_RIDES, filter, function(error, message) {
				if (error) {
					console.error(error);
					return false;
				}
				app.kuzzleController.manageRideProposal(message);
			});
		},

		manageRideProposal: function(rideProposal) {
			var rideInfo = rideProposal._source;

			if (!rideInfo) {
				console.log("no ride info");
				return;
			}

			if (!rideInfo.status) {
				console.log("no status info");
				return;
			}

			if (rideInfo && rideInfo.status.indexOf('proposed_by') !== -1) {
				if (!app.userController.getUser().whoami.available === undefined && !app.userController.getUser().whoami.available) {
					this.declineRideProposal(rideProposal);
					return;
				} else {
					var proposedByTaxy = (rideInfo.status === "proposed_by_taxi");

					var userType = app.userController.getUser() && app.userController.getUser().whoami.type;

					//TODO REMOVE user has change his state between the last time he listening to ride
					if (proposedByTaxy && userType === "taxi")
						return;
					if (!proposedByTaxy && userType === "customer")
						return;
					var target = proposedByTaxy ? rideInfo.customer : rideInfo.taxi;
					var source = !proposedByTaxy ? rideInfo.customer : rideInfo.taxi;
					app.gisController.showPopupRideProposal(source, target, rideProposal);
				}
			} else if (rideInfo.status.indexOf('refused_by') !== -1) {
				app.gisController.onRideRefused(rideProposal);
				currentRide = null;
			} else if (rideInfo.status.indexOf('accepted_by') !== -1) {
				currentRide = rideProposal;
				app.gisController.onRideAccepted(rideProposal);
			} else if (rideInfo.status.indexOf('completed') !== -1) {
				currentRide = null;
				app.gisController.onRideEnded(rideInfo);
			}
		},

		/**
		 * sends a ride proposal to a client/taxi
		 *
		 * @param userId User Id of the *OTHER* person we wish to contact
		 */
		sendRideProposal: function(userId) {
			var
				rideProposal = {},
				myUserType = app.userController.getUser().whoami.type;

			rideProposal['customer'] = myUserType === 'taxi' ? userId : app.userController.getUser().whoami._id;
			rideProposal['taxi'] = myUserType === 'customer' ? userId : app.userController.getUser().whoami._id;
			rideProposal['status'] = 'proposed_by_' + myUserType;
			rideProposal['position'] = app.gisController.getUserPosition();

			/*
			 foolproof check: cleanly decline the previous proposal if somehow a user manages to
			  create another ride while still in the middle of a ride transaction
			*/
			if (currentRide) {
				this.declineRideProposal(currentRide);
			}

			kuzzle.create(CABBLE_COLLECTION_RIDES, rideProposal, true, function(error, response) {
				if (error) {
					console.error(error);
					return false;
				}
				currentRide = response.result;
			});
		},

		/**
		 * accepts a ride proposal
		 *
		 */
		acceptRideProposal: function(rideProposal) {
			console.log("accept ride proposal");
			var
				myUserType = app.userController.getUser().whoami.type,
				acceptedRide = {
					_id: rideProposal._id,
					status: 'accepted_by_' + myUserType
				},
				// All rides, except this one, proposed by others and involving me
				listProposal = {
					filter: {
						and: [{
							term: {
								status: 'proposed_by_' + (myUserType === 'taxi' ? 'customer' : 'taxi')
							}
						}, {
							not: {
								ids: {
									values: [rideProposal._id]
								}
							}
						}]
					}
				},
				userSubFilter = {
					term: {}
				};

			userSubFilter.term[myUserType] = app.userController.getUser().whoami._id;
			listProposal.filter.and.push(userSubFilter);

			app.userController.getUser().whoami.available = false;
			kuzzle.update(CABBLE_COLLECTION_RIDES, acceptedRide);
			currentRide = rideProposal;
			app.gisController.onRideAccepted(currentRide);

			/*
			At this point, we have 1 accepted ride proposal, and possibly multiple
			ride proposed in the meantime.
			So here we list these potential proposals and gracefully decline these
			 */
			console.log('=== LISTPROPOSAL FILTER:', listProposal);
			kuzzle.search(CABBLE_COLLECTION_RIDES, listProposal, function(error, searchResult) {
				if (error) {
					console.log(error);
					return false;
				}

				searchResult.hits.hits.forEach(function(element) {
					// element is not a ride document, but it contains the _id element we need to decline the ride
					app.kuzzleController.declineRideProposal(element);
				});
			});
		},

		/**
		 * declines a ride proposal
		 *
		 */
		declineRideProposal: function(rideProposal) {
			var declinedRide = {
				_id: rideProposal._id,
				status: 'refused_by_' + app.userController.getUser().whoami.type
			};

			kuzzle.update(CABBLE_COLLECTION_RIDES, declinedRide);
		},

		/**
		 * ride conclusion
		 */
		finishRide: function() {
			if (!currentRide) {
				console.log("no curent ride");
				return;
			}

			var finishedRide = {
				_id: currentRide._id,
				status: 'completed'
			};

			app.userController.getUser().whoami.available = true;
			currentRide = null;

			kuzzle.update(CABBLE_COLLECTION_RIDES, finishedRide);
		},

	};
})();
