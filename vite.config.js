import { defineConfig } from 'vite';

const stations = {
  Vyttila: [76.3352, 9.9673],
  Edappally: [76.3084, 10.0265],
  Aluva: [76.349, 10.107]
};
const pilotVehicles = new Map();
const pilotDestinationRequests = new Map();
const pilotShareMatches = new Map();
const vehicleTtlMs = 90 * 1000;
const requestTtlMs = 5 * 60 * 1000;
const shareSearchWindowMs = 60 * 1000;

async function jsonBody(request) {
  let raw = '';
  for await (const chunk of request) raw += chunk;
  return JSON.parse(raw);
}

function send(response, status, body) {
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify(body));
}

function haversineKm([lngA, latA], [lngB, latB]) {
  const toRad = degrees => degrees * Math.PI / 180;
  const dLat = toRad(latB - latA);
  const dLng = toRad(lngB - lngA);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(latA)) * Math.cos(toRad(latB)) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function normalizedDestination(destination) {
  return destination.trim().toLocaleLowerCase().replace(/\s+/g, ' ');
}

function taxiSeatSummary(taxi) {
  const capacity = taxi?.capacity || 4;
  const reserved = (taxi?.reservations || []).reduce((total, reservation) => total + reservation.seats, 0);
  return { capacity, reserved, remaining: Math.max(0, capacity - reserved) };
}

function taxiPoolDestination(taxi) {
  return taxi?.reservations?.[0]?.destinationKey || null;
}

function taxiDirectBooking(taxi) {
  return taxi?.directBooking || null;
}

function addTaxiReservation(taxi, destination, seats, requestIds, tripStartsAt = Date.now()) {
  taxi.reservations = taxi.reservations || [];
  taxi.reservations.push({ destination, destinationKey: normalizedDestination(destination), seats, requestIds, tripStartsAt });
  return taxiSeatSummary(taxi);
}

function taxiTripState(taxi) {
  const reservations = taxi?.reservations || [];
  const tripStartsAt = reservations.length ? Math.max(...reservations.map(reservation => reservation.tripStartsAt || 0)) : null;
  return {
    bookedPassengers: reservations.reduce((total, reservation) => total + reservation.seats, 0),
    tripStartsAt,
    ready: !tripStartsAt || Date.now() >= tripStartsAt
  };
}

function requestExpiresInSeconds(request) {
  return Math.max(0, Math.ceil((request.expiresAt - Date.now()) / 1000));
}

function shareSearchViewFor(request) {
  if (!request?.shareCab || request.status !== 'pending') return null;
  const secondsRemaining = Math.max(0, Math.ceil((request.shareSearchEndsAt - Date.now()) / 1000));
  return {
    phase: secondsRemaining > 0 ? 'searching' : 'timed-out',
    endsAt: request.shareSearchEndsAt,
    secondsRemaining,
    driverVisible: Boolean(request.driverVisible),
    extensionsRemaining: Math.max(0, 1 - (request.shareSearchExtensions || 0))
  };
}

function openTimedOutShareRequests() {
  const now = Date.now();
  for (const request of pilotDestinationRequests.values()) {
    if (request.status === 'pending' && request.shareCab && !request.driverVisible && request.shareSearchEndsAt <= now) request.driverVisible = true;
  }
}

function createShareMatch(firstRequestId, secondRequestId) {
  const first = pilotDestinationRequests.get(firstRequestId);
  const second = pilotDestinationRequests.get(secondRequestId);
  if (!first || !second) return null;
  const id = `share-${crypto.randomUUID()}`;
  const code = `METRO-${crypto.randomUUID().slice(0, 4).toUpperCase()}`;
  const match = {
    id,
    code,
    station: first.station,
    requestIds: [firstRequestId, secondRequestId],
    meetingPoint: `${first.station} taxi bay`,
    confirmedRequestIds: new Set(),
    expiresAt: Math.min(first.expiresAt, second.expiresAt)
  };
  pilotShareMatches.set(id, match);
  first.status = 'matched';
  first.shareMatchId = id;
  second.status = 'matched';
  second.shareMatchId = id;
  return match;
}

function tryCreateShareMatch(requestId) {
  const request = pilotDestinationRequests.get(requestId);
  if (!request || request.status !== 'pending' || !request.shareCab || request.expiresAt <= Date.now() || request.shareSearchEndsAt <= Date.now()) return null;
  const candidate = [...pilotDestinationRequests.entries()].find(([id, item]) => id !== requestId && item.status === 'pending' && item.shareCab && item.station === request.station && item.expiresAt > Date.now() && item.shareSearchEndsAt > Date.now() && normalizedDestination(item.destination) === normalizedDestination(request.destination));
  return candidate ? createShareMatch(requestId, candidate[0]) : null;
}

function releaseShareMatch(matchId, { requeue = true, skipRequestId = null } = {}) {
  const match = pilotShareMatches.get(matchId);
  if (!match) return;
  pilotShareMatches.delete(matchId);
  const requeueIds = [];
  for (const requestId of match.requestIds) {
    const request = pilotDestinationRequests.get(requestId);
    if (!request || request.shareMatchId !== matchId) continue;
    request.shareMatchId = null;
    if (request.status === 'matched') request.status = 'pending';
    if (requeue && requestId !== skipRequestId && request.status === 'pending' && request.shareCab && request.expiresAt > Date.now() && request.shareSearchEndsAt > Date.now()) requeueIds.push(requestId);
  }
  for (const requestId of requeueIds) tryCreateShareMatch(requestId);
}

function shareMatchViewFor(requestId, request) {
  const match = request?.shareMatchId ? pilotShareMatches.get(request.shareMatchId) : null;
  if (!match) return null;
  const yourConfirmed = match.confirmedRequestIds.has(requestId);
  return {
    code: match.code,
    meetingPoint: match.meetingPoint,
    yourConfirmed,
    otherConfirmed: match.confirmedRequestIds.size - Number(yourConfirmed) > 0,
    bothConfirmed: match.confirmedRequestIds.size === match.requestIds.length,
    expiresInSeconds: Math.max(0, Math.ceil((match.expiresAt - Date.now()) / 1000))
  };
}

function removeExpiredData() {
  const now = Date.now();
  for (const [id, vehicle] of pilotVehicles) if (vehicle.updatedAt < now - vehicleTtlMs) pilotVehicles.delete(id);
  for (const [id, match] of pilotShareMatches) if (match.expiresAt <= now) releaseShareMatch(id, { requeue: false });
  for (const [id, request] of pilotDestinationRequests) {
    if (request.expiresAt <= now) {
      if (request.shareMatchId) releaseShareMatch(request.shareMatchId, { requeue: false });
      pilotDestinationRequests.delete(id);
    }
  }
  openTimedOutShareRequests();
  for (const [id, request] of pilotDestinationRequests) if (request.status === 'pending' && request.shareCab && request.shareSearchEndsAt > now) tryCreateShareMatch(id);
}

function pilotApi() {
  return {
    name: 'metromile-pilot-api',
    configureServer(server) {
      server.middlewares.use('/api/pilot-live', async (request, response) => {
        try {
          removeExpiredData();

          if (request.method === 'POST') {
            const body = await jsonBody(request);
            if (body.action === 'share-last-mile') {
              const { requestId, station, destination, shareCab = false } = body;
              if (!requestId || typeof requestId !== 'string' || requestId.length > 100) throw new Error('A valid request ID is required');
              if (!stations[station]) throw new Error('Choose a supported station');
              if (!destination?.trim() || destination.trim().length > 120) throw new Error('Enter a final destination');
              const existing = pilotDestinationRequests.get(requestId);
              if (existing?.status === 'accepted') throw new Error('This request was accepted. Cancel it before starting another one.');
              if (existing?.shareMatchId) releaseShareMatch(existing.shareMatchId, { skipRequestId: requestId });
              const now = Date.now();
              pilotDestinationRequests.set(requestId, {
                station,
                destination: destination.trim(),
                shareCab: Boolean(shareCab),
                status: 'pending',
                driverVisible: !shareCab,
                shareSearchEndsAt: shareCab ? now + shareSearchWindowMs : null,
                shareSearchExtensions: 0,
                createdAt: existing?.createdAt || now,
                expiresAt: now + requestTtlMs
              });
              tryCreateShareMatch(requestId);
              return send(response, 200, { ok: true, expiresInSeconds: requestTtlMs / 1000 });
            }

            if (body.action === 'extend-share-search') {
              const destinationRequest = pilotDestinationRequests.get(body.requestId);
              if (!destinationRequest || destinationRequest.status !== 'pending' || !destinationRequest.shareCab) throw new Error('Only a waiting cab-share search can be extended.');
              if ((destinationRequest.shareSearchExtensions || 0) >= 1) throw new Error('The one extra minute has already been used. Live drivers can accept this request.');
              destinationRequest.driverVisible = false;
              destinationRequest.shareSearchEndsAt = Date.now() + shareSearchWindowMs;
              destinationRequest.shareSearchExtensions = (destinationRequest.shareSearchExtensions || 0) + 1;
              tryCreateShareMatch(body.requestId);
              return send(response, 200, { ok: true, secondsRemaining: shareSearchWindowMs / 1000 });
            }

            if (body.action === 'confirm-share-meeting') {
              const destinationRequest = pilotDestinationRequests.get(body.requestId);
              const match = destinationRequest?.shareMatchId ? pilotShareMatches.get(destinationRequest.shareMatchId) : null;
              if (!destinationRequest || destinationRequest.status !== 'matched' || !match) throw new Error('There is no active cab-share match to confirm.');
              match.confirmedRequestIds.add(body.requestId);
              return send(response, 200, { ok: true, shareMatch: shareMatchViewFor(body.requestId, destinationRequest) });
            }

            if (body.action === 'cancel-last-mile') {
              const destinationRequest = pilotDestinationRequests.get(body.requestId);
              if (!destinationRequest) return send(response, 200, { ok: true });
              if (destinationRequest.status === 'accepted') throw new Error('A driver has already reserved this seat. Contact the driver at the station taxi bay.');
              if (destinationRequest.shareMatchId) releaseShareMatch(destinationRequest.shareMatchId, { skipRequestId: body.requestId });
              pilotDestinationRequests.delete(body.requestId);
              return send(response, 200, { ok: true });
            }

            if (body.action === 'clear-taxi-pool') {
              const driver = pilotVehicles.get(body.driverId);
              if (!driver || driver.role !== 'taxi') throw new Error('Only a live taxi can clear a cab pool.');
              driver.reservations = [];
              return send(response, 200, { ok: true });
            }

            if (body.action === 'complete-taxi-direct-trip') {
              const driver = pilotVehicles.get(body.driverId);
              if (!driver || driver.role !== 'taxi') throw new Error('Only a live taxi can complete a direct trip.');
              if (!driver.directBooking) throw new Error('There is no direct taxi trip to complete.');
              driver.directBooking = null;
              return send(response, 200, { ok: true });
            }

            if (body.action === 'accept-last-mile') {
              const driver = pilotVehicles.get(body.driverId);
              if (!driver || !driver.available || !['taxi', 'feeder'].includes(driver.role)) throw new Error('Share live driver GPS before accepting a request');
              if (body.shareMatchId) {
                const shareMatch = pilotShareMatches.get(body.shareMatchId);
                if (!shareMatch || driver.role !== 'taxi') throw new Error('Only a live taxi can accept a confirmed shared-cab pickup.');
                if (driver.station !== shareMatch.station) throw new Error('This shared pickup is for another station.');
                if (taxiDirectBooking(driver)) throw new Error('Finish the current direct taxi trip before accepting a cab-share pickup.');
                if (shareMatch.confirmedRequestIds.size !== shareMatch.requestIds.length) throw new Error('Both riders must confirm at the taxi bay first.');
                const matchedRequests = shareMatch.requestIds.map(id => pilotDestinationRequests.get(id));
                if (matchedRequests.some(item => !item || item.status !== 'matched')) throw new Error('This shared pickup is no longer available.');
                const destination = matchedRequests[0].destination;
                const poolDestination = taxiPoolDestination(driver);
                const seats = matchedRequests.length;
                const seatSummary = taxiSeatSummary(driver);
                const tripStartsAt = Math.max(...matchedRequests.map(item => item.shareSearchEndsAt || Date.now()));
                if (poolDestination && poolDestination !== normalizedDestination(destination)) throw new Error('Your active pooled cab is going to another destination.');
                if (seatSummary.remaining < seats) throw new Error(`Only ${seatSummary.remaining} seat${seatSummary.remaining === 1 ? '' : 's'} remain in this cab.`);
                const updatedSeats = addTaxiReservation(driver, destination, seats, shareMatch.requestIds, tripStartsAt);
                for (const item of matchedRequests) {
                  item.status = 'accepted';
                  item.shareMatchId = null;
                  item.acceptedBy = 'taxi';
                  item.routeName = null;
                  item.feederDestination = null;
                  item.taxiCapacity = updatedSeats.capacity;
                  item.taxiReservedSeats = updatedSeats.reserved;
                  item.taxiRemainingSeats = updatedSeats.remaining;
                  item.taxiTripStartsAt = tripStartsAt;
                  item.bookingType = 'taxi-share-pair';
                }
                pilotShareMatches.delete(shareMatch.id);
                return send(response, 200, { ok: true, riders: matchedRequests.length, seats: updatedSeats });
              }
              const destinationRequest = pilotDestinationRequests.get(body.requestId);
              if (!destinationRequest || destinationRequest.status !== 'pending') throw new Error('This destination request is no longer available');
              if (driver.station !== destinationRequest.station) throw new Error('This request is for another station');
              if (destinationRequest.shareMatchId) releaseShareMatch(destinationRequest.shareMatchId, { skipRequestId: body.requestId });
              if (!destinationRequest.driverVisible && destinationRequest.shareCab) {
                if (driver.role !== 'taxi') throw new Error('Only a taxi can reserve a seat during cab-share search.');
                if (taxiDirectBooking(driver)) throw new Error('Finish the current direct taxi trip before reserving a cab-share seat.');
                const poolDestination = taxiPoolDestination(driver);
                const seatSummary = taxiSeatSummary(driver);
                if (poolDestination && poolDestination !== normalizedDestination(destinationRequest.destination)) throw new Error('Your active pooled cab is going to another destination.');
                if (seatSummary.remaining < 1) throw new Error('This cab has no seats remaining.');
                const tripStartsAt = destinationRequest.shareSearchEndsAt;
                const updatedSeats = addTaxiReservation(driver, destinationRequest.destination, 1, [body.requestId], tripStartsAt);
                destinationRequest.status = 'accepted';
                destinationRequest.acceptedBy = 'taxi';
                destinationRequest.routeName = null;
                destinationRequest.feederDestination = null;
                destinationRequest.taxiCapacity = updatedSeats.capacity;
                destinationRequest.taxiReservedSeats = updatedSeats.reserved;
                destinationRequest.taxiRemainingSeats = updatedSeats.remaining;
                destinationRequest.taxiTripStartsAt = tripStartsAt;
                destinationRequest.bookingType = 'taxi-share-reservation';
                return send(response, 200, { ok: true, reservation: true, seats: updatedSeats });
              }
              if (!destinationRequest.driverVisible) throw new Error('This rider is still in the private cab-share search window.');
              if (driver.role === 'taxi') {
                if (taxiDirectBooking(driver)) throw new Error('Finish the current direct taxi trip before accepting another rider.');
                if (driver.reservations?.length) throw new Error('Finish the active cab-share pool before accepting a direct taxi ride.');
                driver.directBooking = { requestId: body.requestId, destination: destinationRequest.destination, acceptedAt: Date.now() };
                destinationRequest.taxiCapacity = null;
                destinationRequest.taxiReservedSeats = null;
                destinationRequest.taxiRemainingSeats = null;
                destinationRequest.taxiTripStartsAt = null;
                destinationRequest.bookingType = 'taxi-direct';
              } else {
                destinationRequest.bookingType = 'feeder-direct';
              }
              destinationRequest.status = 'accepted';
              destinationRequest.acceptedBy = driver.role;
              destinationRequest.routeName = driver.role === 'feeder' ? driver.routeName : null;
              destinationRequest.feederDestination = driver.role === 'feeder' ? driver.destination : null;
              return send(response, 200, { ok: true });
            }

            const { id, role, station, source, destination, routeName, latitude, longitude, speedMps = 0, available = true, capacity = 4 } = body;
            if (!id || typeof id !== 'string' || id.length > 100) throw new Error('A valid pilot device ID is required');
            if (!['taxi', 'feeder'].includes(role)) throw new Error('Choose taxi or feeder pilot mode');
            if (!stations[station]) throw new Error('Choose a supported station');
            if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) throw new Error('A valid GPS position is required');
            if (role === 'feeder' && (!stations[source] || !destination?.trim() || !routeName?.trim() || destination.trim().length > 80 || routeName.trim().length > 80)) throw new Error('Enter feeder source, route, and destination');
            const taxiCapacity = Math.floor(Number(capacity));
            if (role === 'taxi' && (!Number.isInteger(taxiCapacity) || taxiCapacity < 1 || taxiCapacity > 6)) throw new Error('Choose a taxi capacity from 1 to 6 seats');
            const previousVehicle = pilotVehicles.get(id);
            if (role === 'taxi' && taxiSeatSummary(previousVehicle).reserved > taxiCapacity) throw new Error('Taxi capacity cannot be lower than seats already reserved.');
            pilotVehicles.set(id, {
              role,
              station: role === 'feeder' ? source : station,
              source: role === 'feeder' ? source : null,
              destination: role === 'feeder' ? destination.trim() : null,
              routeName: role === 'feeder' ? routeName.trim() : null,
              point: [longitude, latitude],
              speedMps: Number(speedMps) || 0,
              available: Boolean(available),
              capacity: role === 'taxi' ? taxiCapacity : null,
              reservations: role === 'taxi' ? previousVehicle?.reservations || [] : [],
              directBooking: role === 'taxi' ? previousVehicle?.directBooking || null : null,
              updatedAt: Date.now()
            });
            const targetStation = role === 'feeder' ? source : station;
            const distanceToStationKm = haversineKm([longitude, latitude], stations[targetStation]);
            return send(response, 200, {
              ok: true,
              expiresInSeconds: vehicleTtlMs / 1000,
              distanceToStationKm: Math.round(distanceToStationKm * 10) / 10,
              counted: role === 'taxi' ? Boolean(available) && distanceToStationKm <= 3 : null
            });
          }

          if (request.method === 'GET') {
            const params = new URL(request.url, 'http://localhost').searchParams;
            const station = params.get('station');
            if (!stations[station]) return send(response, 400, { error: 'Choose a supported station' });
            const stationPoint = stations[station];
            const activeTaxis = [...pilotVehicles.values()].filter(vehicle => vehicle.available && vehicle.role === 'taxi' && vehicle.station === station && haversineKm(vehicle.point, stationPoint) <= 3);
            const feederServices = [...pilotVehicles.values()].filter(vehicle => vehicle.available && vehicle.role === 'feeder' && vehicle.station === station).map(vehicle => {
              const distanceKm = haversineKm(vehicle.point, stationPoint);
              const speedKmh = vehicle.speedMps > 1 ? Math.min(vehicle.speedMps * 3.6, 45) : 18;
              return {
                source: vehicle.source,
                destination: vehicle.destination,
                routeName: vehicle.routeName,
                boarding: distanceKm <= 0.75,
                etaMinutes: Math.max(1, Math.ceil(distanceKm / speedKmh * 60))
              };
            });
            const storedPassengerRequest = pilotDestinationRequests.get(params.get('requestId'));
            const passengerRequest = storedPassengerRequest?.station === station ? storedPassengerRequest : null;
            const driver = pilotVehicles.get(params.get('driverId'));
            const driverSeats = driver?.role === 'taxi' ? taxiSeatSummary(driver) : null;
            const pooledDestination = driver?.role === 'taxi' ? taxiPoolDestination(driver) : null;
            const directBooking = driver?.role === 'taxi' ? taxiDirectBooking(driver) : null;
            const driverCanReceive = driver?.available && ['taxi', 'feeder'].includes(driver.role) && driver.station === station && !(driver.role === 'taxi' && directBooking);
            const taxiCanAddSeats = driver?.role === 'taxi' && !directBooking && driverSeats.remaining > 0;
            const isDestinationCompatible = item => !pooledDestination || normalizedDestination(item.destination) === pooledDestination;
            const individualDriverRequests = driverCanReceive ? [...pilotDestinationRequests.entries()].filter(([, item]) => item.station === station && item.status === 'pending' && item.driverVisible && (driver.role !== 'taxi' || (taxiCanAddSeats && isDestinationCompatible(item)))).map(([id, item]) => ({ id, kind: 'solo', destination: item.destination, riders: 1 })) : [];
            const shareSearchPreviews = driverCanReceive && driver.role === 'taxi' && taxiCanAddSeats ? [...pilotDestinationRequests.entries()].filter(([, item]) => item.station === station && item.status === 'pending' && item.shareCab && !item.driverVisible && item.shareSearchEndsAt > Date.now() && isDestinationCompatible(item)).map(([id, item]) => ({ id, kind: 'share-search', destination: item.destination, shareSearchEndsAt: item.shareSearchEndsAt })) : [];
            const sharedDriverRequests = driverCanReceive && driver.role === 'taxi' && taxiCanAddSeats ? [...pilotShareMatches.values()].filter(match => {
              const leadRequest = pilotDestinationRequests.get(match.requestIds[0]);
              return match.station === station && match.confirmedRequestIds.size === match.requestIds.length && leadRequest && isDestinationCompatible(leadRequest) && driverSeats.remaining >= match.requestIds.length;
            }).map(match => {
              const leadRequest = pilotDestinationRequests.get(match.requestIds[0]);
              return { id: match.id, kind: 'shared', destination: leadRequest.destination, riders: match.requestIds.length };
            }) : [];
            const driverRequests = [...shareSearchPreviews, ...individualDriverRequests, ...sharedDriverRequests];
            return send(response, 200, {
              source: 'MetroMile pilot devices',
              feeder: { services: feederServices },
              taxi: { available: activeTaxis.length },
              request: passengerRequest ? {
                status: passengerRequest.status,
                station: passengerRequest.station,
                destination: passengerRequest.destination,
                shareCab: passengerRequest.shareCab,
                shareSearch: shareSearchViewFor(passengerRequest),
                shareMatch: shareMatchViewFor(params.get('requestId'), passengerRequest),
                expiresInSeconds: requestExpiresInSeconds(passengerRequest),
                acceptedBy: passengerRequest.acceptedBy || null,
                routeName: passengerRequest.routeName || null,
                feederDestination: passengerRequest.feederDestination || null,
                taxiCapacity: passengerRequest.taxiCapacity || null,
                taxiReservedSeats: passengerRequest.taxiReservedSeats ?? null,
                taxiRemainingSeats: passengerRequest.taxiRemainingSeats ?? null,
                taxiTripStartsAt: passengerRequest.taxiTripStartsAt || null,
                bookingType: passengerRequest.bookingType || null
              } : null,
              driverRequests,
              driverCapacity: driverSeats ? { ...driverSeats, destination: driver.reservations?.[0]?.destination || null, trip: taxiTripState(driver), directBooking } : null,
              expiresInSeconds: vehicleTtlMs / 1000
            });
          }

          return send(response, 405, { error: 'Method not allowed' });
        } catch (error) {
          return send(response, 422, { error: error.message || 'Pilot feed unavailable' });
        }
      });
    }
  };
}

export default defineConfig({
  server: { allowedHosts: true },
  plugins: [pilotApi()]
});
