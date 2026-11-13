// MetroMile Comprehensive Backend & API End-to-End Test Suite
import assert from 'node:assert/strict';

const BASE_URL = 'http://localhost:5180';

async function api(path, options = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const data = await res.json();
  return { status: res.status, ok: res.ok, data };
}

async function runTests() {
  console.log('🚀 Starting MetroMile Full End-to-End Functional Test Suite...\n');
  let passed = 0;
  let total = 0;

  async function test(name, fn) {
    total++;
    try {
      await fn();
      console.log(`  ✅ [PASS] ${name}`);
      passed++;
    } catch (err) {
      console.error(`  ❌ [FAIL] ${name}:`, err.message);
      throw err;
    }
  }

  // TEST 1: Initial state & stations
  await test('Initial state returns valid empty feed for all 3 stations', async () => {
    for (const station of ['Vyttila', 'Edappally', 'Aluva']) {
      const res = await api(`/api/pilot-live?station=${encodeURIComponent(station)}`);
      assert.equal(res.status, 200);
      assert.equal(res.data.source, 'MetroMile pilot devices');
      assert.equal(Array.isArray(res.data.feeder.services), true);
      assert.equal(typeof res.data.taxi.available, 'number');
      assert.equal(res.data.request, null);
    }
  });

  const runId = Date.now();
  const taxiDriverId = `taxi-pilot-unit-${runId}`;
  const feederDriverId = `feeder-kmrl-${runId}`;
  const soloPaxId = `pax-solo-${runId}`;
  const sharePax1 = `pax-share-alpha-${runId}`;
  const sharePax2 = `pax-share-beta-${runId}`;
  const paxExtend = `pax-extend-${runId}`;
  await test('Taxi driver GPS broadcast within 3km is counted as available', async () => {
    const gpsRes = await api('/api/pilot-live', {
      method: 'POST',
      body: JSON.stringify({
        id: taxiDriverId,
        role: 'taxi',
        station: 'Vyttila',
        latitude: 9.9675,
        longitude: 76.3355,
        speedMps: 0,
        available: true,
        capacity: 4
      })
    });
    assert.equal(gpsRes.status, 200);
    assert.equal(gpsRes.data.counted, true);
    assert.ok(gpsRes.data.distanceToStationKm < 0.1);

    const stationRes = await api('/api/pilot-live?station=Vyttila');
    assert.ok(stationRes.data.taxi.available >= 1);
  });

  await test('Taxi driver GPS broadcast beyond 3km is NOT counted at station', async () => {
    const distantDriverId = 'taxi-pilot-distant-2';
    const gpsRes = await api('/api/pilot-live', {
      method: 'POST',
      body: JSON.stringify({
        id: distantDriverId,
        role: 'taxi',
        station: 'Vyttila',
        latitude: 10.2000,
        longitude: 76.5000,
        speedMps: 15,
        available: true,
        capacity: 4
      })
    });
    assert.equal(gpsRes.status, 200);
    assert.equal(gpsRes.data.counted, false);
    assert.ok(gpsRes.data.distanceToStationKm > 20);
  });

  // TEST 3: Feeder Bus Telemetry
  await test('Feeder GPS broadcast near station shows "boarding: true"', async () => {
    const feederRes = await api('/api/pilot-live', {
      method: 'POST',
      body: JSON.stringify({
        id: feederDriverId,
        role: 'feeder',
        station: 'Vyttila',
        source: 'Vyttila',
        routeName: 'KMRL F04',
        destination: 'CUSAT Campus',
        latitude: 9.9674,
        longitude: 76.3353,
        speedMps: 0,
        available: true
      })
    });
    assert.equal(feederRes.status, 200);
    assert.equal(feederRes.data.ok, true);

    const stationRes = await api('/api/pilot-live?station=Vyttila');
    const service = stationRes.data.feeder.services.find(s => s.routeName === 'KMRL F04');
    assert.ok(service, 'Feeder service should be listed');
    assert.equal(service.boarding, true);
    assert.equal(service.destination, 'CUSAT Campus');
  });

  await test('Feeder GPS broadcast further away computes dynamic ETA in minutes', async () => {
    const distantFeederId = 'feeder-kmrl-f02';
    // ~2.5 km away traveling at 36 km/h (10 m/s)
    await api('/api/pilot-live', {
      method: 'POST',
      body: JSON.stringify({
        id: distantFeederId,
        role: 'feeder',
        station: 'Vyttila',
        source: 'Vyttila',
        routeName: 'KMRL F02',
        destination: 'Kakkanad Hub',
        latitude: 9.9850,
        longitude: 76.3500,
        speedMps: 10,
        available: true
      })
    });

    const stationRes = await api('/api/pilot-live?station=Vyttila');
    const service = stationRes.data.feeder.services.find(s => s.routeName === 'KMRL F02');
    assert.ok(service, 'Feeder service F02 should be listed');
    assert.equal(service.boarding, false);
    assert.ok(service.etaMinutes > 1, `ETA should be > 1 min, got ${service.etaMinutes}`);
  });

  // TEST 4: Solo Passenger Request & Direct Taxi Trip Lifecycle
  await test('Solo passenger last-mile request is published and visible to active taxi', async () => {
    const reqRes = await api('/api/pilot-live', {
      method: 'POST',
      body: JSON.stringify({
        action: 'share-last-mile',
        requestId: soloPaxId,
        station: 'Vyttila',
        destination: 'Kaloor Stadium',
        shareCab: false
      })
    });
    assert.equal(reqRes.status, 200);

    // Verify passenger view
    const paxRes = await api(`/api/pilot-live?station=Vyttila&requestId=${soloPaxId}`);
    assert.equal(paxRes.data.request.status, 'pending');
    assert.equal(paxRes.data.request.destination, 'Kaloor Stadium');
    assert.equal(paxRes.data.request.shareCab, false);

    // Verify driver request board
    const driverRes = await api(`/api/pilot-live?station=Vyttila&driverId=${taxiDriverId}`);
    const pickup = driverRes.data.driverRequests.find(r => r.id === soloPaxId);
    assert.ok(pickup, 'Driver should see solo request');
    assert.equal(pickup.kind, 'solo');
    assert.equal(pickup.destination, 'Kaloor Stadium');
  });

  await test('Taxi driver accepts solo request -> locks into direct trip', async () => {
    const acceptRes = await api('/api/pilot-live', {
      method: 'POST',
      body: JSON.stringify({
        action: 'accept-last-mile',
        driverId: taxiDriverId,
        requestId: soloPaxId
      })
    });
    assert.equal(acceptRes.status, 200);

    // Check passenger sees direct taxi confirmation
    const paxRes = await api(`/api/pilot-live?station=Vyttila&requestId=${soloPaxId}`);
    assert.equal(paxRes.data.request.status, 'accepted');
    assert.equal(paxRes.data.request.acceptedBy, 'taxi');
    assert.equal(paxRes.data.request.bookingType, 'taxi-direct');

    // Check driver capacity shows active direct booking
    const driverRes = await api(`/api/pilot-live?station=Vyttila&driverId=${taxiDriverId}`);
    assert.ok(driverRes.data.driverCapacity.directBooking);
    assert.equal(driverRes.data.driverCapacity.directBooking.destination, 'Kaloor Stadium');
  });

  await test('Taxi driver completes direct trip -> resets driver capacity', async () => {
    const finishRes = await api('/api/pilot-live', {
      method: 'POST',
      body: JSON.stringify({
        action: 'complete-taxi-direct-trip',
        driverId: taxiDriverId
      })
    });
    assert.equal(finishRes.status, 200);

    const driverRes = await api(`/api/pilot-live?station=Vyttila&driverId=${taxiDriverId}`);
    assert.equal(driverRes.data.driverCapacity.directBooking, null);
    assert.equal(driverRes.data.driverCapacity.reserved, 0);
  });

  // TEST 5: Cab-Share 1-Minute Private Search Window
  const shareDestination = `Infopark Kakkanad ${runId}`;
  await test('Cab-share request initiates 60s private search; hidden from solo drivers', async () => {
    const shareRes = await api('/api/pilot-live', {
      method: 'POST',
      body: JSON.stringify({
        action: 'share-last-mile',
        requestId: sharePax1,
        station: 'Vyttila',
        destination: shareDestination,
        shareCab: true
      })
    });
    assert.equal(shareRes.status, 200);

    // Check passenger view
    const paxRes = await api(`/api/pilot-live?station=Vyttila&requestId=${sharePax1}`);
    assert.equal(paxRes.data.request.status, 'pending');
    assert.equal(paxRes.data.request.shareSearch.phase, 'searching');
    assert.equal(paxRes.data.request.shareSearch.driverVisible, false);
    assert.ok(paxRes.data.request.shareSearch.secondsRemaining > 50);

    // Driver should NOT see this request as a solo pickup
    const driverRes = await api(`/api/pilot-live?station=Vyttila&driverId=${taxiDriverId}`);
    const soloOption = driverRes.data.driverRequests.find(r => r.id === sharePax1 && r.kind === 'solo');
    assert.equal(soloOption, undefined, 'Private cab-share search must not be shown as solo pickup');
  });

  // TEST 6: Multi-Rider Algorithmic Cab-Share Matching
  let matchId = null;
  let matchCode = null;
  await test('Second rider requesting same destination triggers instant algorithmic match', async () => {
    const shareRes2 = await api('/api/pilot-live', {
      method: 'POST',
      body: JSON.stringify({
        action: 'share-last-mile',
        requestId: sharePax2,
        station: 'Vyttila',
        destination: shareDestination.toLowerCase(), // test case-insensitivity
        shareCab: true
      })
    });
    assert.equal(shareRes2.status, 200);

    // Verify Passenger 1 is matched
    const pax1Res = await api(`/api/pilot-live?station=Vyttila&requestId=${sharePax1}`);
    assert.equal(pax1Res.data.request.status, 'matched');
    assert.ok(pax1Res.data.request.shareMatch);
    matchCode = pax1Res.data.request.shareMatch.code;
    assert.ok(matchCode.startsWith('METRO-'), `Match code should start with METRO-, got ${matchCode}`);
    assert.equal(pax1Res.data.request.shareMatch.meetingPoint, 'Vyttila taxi bay');

    // Verify Passenger 2 has the exact same match code
    const pax2Res = await api(`/api/pilot-live?station=Vyttila&requestId=${sharePax2}`);
    assert.equal(pax2Res.data.request.status, 'matched');
    assert.equal(pax2Res.data.request.shareMatch.code, matchCode);
  });

  // TEST 7: Two-Sided In-Person Check-In at Taxi Bay
  await test('Both riders check in with confirmation at the meeting point', async () => {
    // Rider 1 checks in
    await api('/api/pilot-live', {
      method: 'POST',
      body: JSON.stringify({
        action: 'confirm-share-meeting',
        requestId: sharePax1
      })
    });
    const pax1Mid = await api(`/api/pilot-live?station=Vyttila&requestId=${sharePax1}`);
    assert.equal(pax1Mid.data.request.shareMatch.yourConfirmed, true);
    assert.equal(pax1Mid.data.request.shareMatch.bothConfirmed, false);

    // Rider 2 checks in
    await api('/api/pilot-live', {
      method: 'POST',
      body: JSON.stringify({
        action: 'confirm-share-meeting',
        requestId: sharePax2
      })
    });
    const pax1Final = await api(`/api/pilot-live?station=Vyttila&requestId=${sharePax1}`);
    assert.equal(pax1Final.data.request.shareMatch.bothConfirmed, true);

    const pax2Final = await api(`/api/pilot-live?station=Vyttila&requestId=${sharePax2}`);
    assert.equal(pax2Final.data.request.shareMatch.bothConfirmed, true);
  });

  // TEST 8: Driver Accepts Confirmed Cab-Share Pair
  await test('Taxi driver reserves seats for the confirmed 2-rider cab-share pair', async () => {
    // Driver board now shows shared request
    const driverRes = await api(`/api/pilot-live?station=Vyttila&driverId=${taxiDriverId}`);
    const sharedPickup = driverRes.data.driverRequests.find(r => r.kind === 'shared' && r.destination.toLowerCase() === shareDestination.toLowerCase());
    assert.ok(sharedPickup, 'Driver should see shared match');
    assert.equal(sharedPickup.kind, 'shared');
    assert.equal(sharedPickup.riders, 2);
    matchId = sharedPickup.id;

    // Driver reserves shared seats
    const acceptRes = await api('/api/pilot-live', {
      method: 'POST',
      body: JSON.stringify({
        action: 'accept-last-mile',
        driverId: taxiDriverId,
        shareMatchId: matchId
      })
    });
    assert.equal(acceptRes.status, 200);

    // Check taxi driver capacity: 2 reserved, 2 remaining
    const driverAfter = await api(`/api/pilot-live?station=Vyttila&driverId=${taxiDriverId}`);
    assert.equal(driverAfter.data.driverCapacity.reserved, 2);
    assert.equal(driverAfter.data.driverCapacity.remaining, 2);

    // Check passengers receive taxi-share confirmation
    const pax1Check = await api(`/api/pilot-live?station=Vyttila&requestId=${sharePax1}`);
    assert.equal(pax1Check.data.request.status, 'accepted');
    assert.equal(pax1Check.data.request.bookingType, 'taxi-share-pair');
  });

  // TEST 9: Clear Taxi Cab Pool
  await test('Ending completed cab pool releases reserved seats', async () => {
    const clearRes = await api('/api/pilot-live', {
      method: 'POST',
      body: JSON.stringify({
        action: 'clear-taxi-pool',
        driverId: taxiDriverId
      })
    });
    assert.equal(clearRes.status, 200);

    const driverRes = await api(`/api/pilot-live?station=Vyttila&driverId=${taxiDriverId}`);
    assert.equal(driverRes.data.driverCapacity.reserved, 0);
    assert.equal(driverRes.data.driverCapacity.remaining, 4);
  });

  // TEST 10: Share Search Extension and Cancellation
  await test('Share search extension extends search window by 60 seconds', async () => {
    const paxExtendLocal = `pax-extend-${Date.now()}`;
    await api('/api/pilot-live', {
      method: 'POST',
      body: JSON.stringify({
        action: 'share-last-mile',
        requestId: paxExtendLocal,
        station: 'Edappally',
        destination: `LuLu Mall Gate 2 ${Date.now()}`,
        shareCab: true
      })
    });

    const extendRes = await api('/api/pilot-live', {
      method: 'POST',
      body: JSON.stringify({
        action: 'extend-share-search',
        requestId: paxExtendLocal
      })
    });
    assert.equal(extendRes.status, 200);
    assert.equal(extendRes.data.ok, true);
    assert.equal(extendRes.data.secondsRemaining, 60);
  });

  await test('Passenger cancels last-mile request cleanly', async () => {
    const paxCancelLocal = `pax-cancel-${Date.now()}`;
    await api('/api/pilot-live', {
      method: 'POST',
      body: JSON.stringify({
        action: 'share-last-mile',
        requestId: paxCancelLocal,
        station: 'Edappally',
        destination: `LuLu Mall Gate 1 ${Date.now()}`,
        shareCab: true
      })
    });

    const cancelRes = await api('/api/pilot-live', {
      method: 'POST',
      body: JSON.stringify({
        action: 'cancel-last-mile',
        requestId: paxCancelLocal
      })
    });
    assert.equal(cancelRes.status, 200);

    const checkRes = await api(`/api/pilot-live?station=Edappally&requestId=${paxCancelLocal}`);
    assert.equal(checkRes.data.request, null);
  });

  // TEST 11: Error handling & validation
  await test('Malformed requests return appropriate HTTP error status codes', async () => {
    // Missing station on GET returns 400
    const err1 = await api('/api/pilot-live');
    assert.equal(err1.status, 400);

    // Invalid action on POST returns 422
    const err2 = await api('/api/pilot-live', {
      method: 'POST',
      body: JSON.stringify({ action: 'unknown-action' })
    });
    assert.equal(err2.status, 422);

    // Non-existent request accept returns 422
    const err3 = await api('/api/pilot-live', {
      method: 'POST',
      body: JSON.stringify({ action: 'accept-last-mile', driverId: 'taxi-1', requestId: 'non-existent' })
    });
    assert.equal(err3.status, 422);
  });

  console.log(`\n🎉 All ${passed}/${total} MetroMile Backend & API Functional Tests PASSED!`);
}

runTests().catch(err => {
  console.error('\n💥 Test suite execution failed:', err);
  process.exit(1);
});
