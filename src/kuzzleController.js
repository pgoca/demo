////////////////////////kuzzle module/////////////////

window.kuzzleController = (function() {
	var
	//KUZZLE_URL = 'api.uat.kuzzle.io:7512',
		KUZZLE_URL = 'http://localhost:7512',
		CABBLE_COLLECTION_POSITIONS = 'cabble-positions',
		CABBLE_COLLECTION_USERS = 'cabble-users',
		CABBLE_COLLECTION_RIDES = 'cabble-rides';

	//////////////////privates attributes///////////////////////
	var
		kuzzle = Kuzzle.init(KUZZLE_URL),
		refreshFilterTimer,
		positionsRoom,
		ridesRoom,
		userSubscribeRoom,
		currentRide;

	return {
		init: function() {
			return new Promise(
				function(resolve, reject) {
					// TODO: retrieve userId from localstorage
					var user = userController.getUser();
					if (!user.userId) {
						kuzzle.create(CABBLE_COLLECTION_USERS, user.whoami, true, function(error, response) {
							if (error) {
								console.error(error);
								reject();
							} else {
								user.userId = response._id;
								user.whoami._id = response._id;
								userController.setInLocalStorage().then(
									function() {
										kuzzleController.initListener();
										resolve();
									}
								);
							}
						});
					}
					kuzzleController.initListener();
					resolve();
				});
		},

		initListener: function() {
			kuzzleController.listenToUserChange();
			kuzzleController.listenToRidesProposals();
			setInterval(kuzzleController.sendMyPosition.bind(app.kuzzleController), 3000);
		},

		sendMyPosition: function() {
			var userPosition = gisController.getUserPosition();
			var userId = userController.getUserId();
			var userType = userController.getUserType();

			if (!userPosition) {
				console.log("no position for user");
				return;
			}
			if (!userType)
				return;

			kuzzle.create(CABBLE_COLLECTION_POSITIONS, {
				userId: userId,
				type: userType,
				position: {
					lat: userPosition.lat,
					lon: userPosition.lng
				},
				userSubscribeRoom: userSubscribeRoom
			}, false);
		},

		/**
		 * - Gets the top-left and bottom-right corners coordinates from google maps
		 * - Creates a kuzzle filter including geolocalization bounding box
		 * - Unsubscribe from previous room if we were listening to one
		 * - Subscribe to kuzzle with the new filter
		 */
		listenToPositionsFilter: function() {
			var
				bound = gisController.getMapBounds(),
				user = userController.getUser();

			if (!user.whoami.type)
				return;

			var filterUserType = userController.getUserType() === 'taxi' ? 'customer' : 'taxi',
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

			if (currentRide && currentRide.status && currentRide.status.indexOf('accepted') !== -1) {
				filter.and.push({
					term: {
						_id: userController.getUserType() === 'taxi' ? currentRide.customer : currentRide.taxi
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

					console.log("recive userSubscribeRoom room " + userSubscribeRoom);

					//user has change his state between the last time he listening to ride
					if (candidateType === userController.getUserType())
						return;

					gisController.addMarker(candidatePosition, candidateType, candidateId);
				}
			});
		},

		setUserType: function(userType) {
			if (!userType)
				return;

			userController.setUserType(userType)
				.then(function() {
					gisController.setUserType(userType);

					kuzzleController.listenToUserChange();
					kuzzleController.listenToRidesProposals();
					console.log("update user " + userController.getUserId());
					kuzzle.update(CABBLE_COLLECTION_USERS, userController.getUser().whoami);
					var refreshInterval = 5000;
					if (userType === 'customer') {
						refreshInterval = 6000;
					} else if (userType === 'taxi') {
						refreshInterval = 1000;
					}

					if (refreshFilterTimer) {
						clearInterval(refreshFilterTimer);
					}
					kuzzleController.listenToPositionsFilter()

					refreshFilterTimer = setInterval(function() {
						kuzzleController.listenToPositionsFilter()
					}.bind(this), refreshInterval);
				});
		},

		listenToUserChange: function() {
			if (!userController.getUserType())
				return;

			var userStatus = {
				exists: {
					field: 'type'
						//type: [userController.getUserType() === "taxi" ? "customer" : "taxi"]
				}
			};

			if (userSubscribeRoom)
				kuzzle.unsubscribe(userSubscribeRoom);

			userSubscribeRoom = kuzzle.subscribe(CABBLE_COLLECTION_USERS, userStatus, function(error, message) {
				if (error) {
					console.error(error);
					return false;
				}

				console.log("user subscrib ");
				console.log(message);
				if (!message.action == "off")
					return;

				var userChanged = message._source;

				//a previous user candidate is now a concurent, we remove it from view
				if (userChanged && userController.getUserType() === userChanged.type) {
					gisController.removeCandidate(userChanged._id);
				}

				//we where in ride with this candidate, we must break the ride
				if (currentRide && (currentRide._source.taxi === userChanged._id ||  currentRide._source.customer === userChanged._id)) {
					kuzzleController.finishRide();
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

			var user = userController.getUser();

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
				kuzzleController.manageRideProposal(message);
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
				if (!userController.isAvailable()) {
					this.declineRideProposal(rideProposal);
					return;
				} else {
					var candidateType = (rideInfo.status === "proposed_by_taxi") ? "taxi" : "customer";

					var userType = userController.getUserType();

					//TODO REMOVE user has change his state between the last time he listening to ride
					if (userType === candidateType)
						return;
					var target = (rideInfo.status === "proposed_by_taxi") ? rideInfo.customer : rideInfo.taxi;
					var source = (rideInfo.status === "proposed_by_taxi") ? rideInfo.taxi : rideInfo.customer;
					gisController.showPopupRideProposal(source, target, rideProposal);
				}
			} else if (rideInfo.status.indexOf('refused_by') !== -1) {
				gisController.onRideRefused(rideProposal);
				currentRide = null;
			} else if (rideInfo.status.indexOf('accepted_by') !== -1) {
				currentRide = rideProposal;
				gisController.onRideAccepted(rideProposal);
			} else if (rideInfo.status.indexOf('completed') !== -1) {
				currentRide = null;
				gisController.onRideEnded(rideInfo);
			}
		},

		/**
		 * sends a ride proposal to a client/taxi
		 *
		 * @param candidateId User Id of the candidate we wish to contact
		 */
		sendRideProposal: function(candidateId) {
			var
				rideProposal = {},
				myUserType = userController.getUserType();

			rideProposal['customer'] = myUserType === 'taxi' ? candidateId : userController.getUserId();
			rideProposal['taxi'] = myUserType === 'customer' ? candidateId : userController.getUserId();
			rideProposal['status'] = 'proposed_by_' + myUserType;
			rideProposal['position'] = gisController.getUserPosition();

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
				myUserType = userController.getUser().whoami.type,
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

			userSubFilter.term[myUserType] = userController.getUser().whoami._id;
			listProposal.filter.and.push(userSubFilter);

			userController.getUser().whoami.available = false;
			kuzzle.update(CABBLE_COLLECTION_RIDES, acceptedRide);
			currentRide = rideProposal;
			gisController.onRideAccepted(currentRide);

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
					kuzzleController.declineRideProposal(element);
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
				status: 'refused_by_' + userController.getUser().whoami.type
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

			userController.getUser().whoami.available = true;
			//gisController.onRideEnded(currentRide);
			//currentRide = null;

			kuzzle.update(CABBLE_COLLECTION_RIDES, finishedRide);
		},

	};
})();
