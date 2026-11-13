import React, { useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

const stations = ['Vyttila', 'Edappally', 'Aluva'];

function pilotDeviceId(role) {
  const key = `metromile-pilot-${role}-device`;
  const existing = localStorage.getItem(key);
  if (existing) return existing;
  const id = crypto.randomUUID();
  localStorage.setItem(key, id);
  return id;
}

async function sendPilot(payload) {
  const response = await fetch('/api/pilot-live', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Pilot service unavailable');
  return data;
}

function formatCountdown(seconds) {
  const safeSeconds = Math.max(0, seconds);
  return `${Math.floor(safeSeconds / 60)}:${String(safeSeconds % 60).padStart(2, '0')}`;
}

function TransferSummary({ station }) {
  const [feed, setFeed] = useState(null);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch(`/api/pilot-live?station=${encodeURIComponent(station)}`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      setFeed(data);
    } catch {
      setFeed(null);
    }
  }, [station]);

  useEffect(() => {
    refresh();
    const timer = window.setInterval(refresh, 3000);
    window.addEventListener('metromile-live-update', refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('metromile-live-update', refresh);
    };
  }, [refresh]);

  const services = feed?.feeder.services || [];
  const feeder = services.find(item => item.boarding) || services[0];
  const taxis = feed?.taxi.available || 0;

  return (
    <section className="glance-card transfer-summary">
      <span className="mini-label">ONE-GLANCE TRANSFER</span>
      <h2>{station}: your next move</h2>
      <div className="glance-grid">
        <div>
          <small>FEEDER BUS</small>
          {feeder ? <><strong>{feeder.boarding ? 'Boarding now' : `Driver GPS: station in ${feeder.etaMinutes} min`}</strong><em>{feeder.routeName} · {feeder.destination}</em></> : <><strong>No feeder sharing GPS</strong><em>Timing appears when a driver shares a route and location.</em></>}
        </div>
        <div>
          <small>TAXI DRIVERS</small>
          <strong>{taxis ? `${taxis} sharing GPS` : 'None sharing GPS'}</strong>
          <em>{taxis ? 'Opt-in MetroMile drivers nearby' : 'Pilot drivers within 3 km appear here'}</em>
        </div>
      </div>
    </section>
  );
}

function savedLastMileRequest() {
  try {
    const saved = JSON.parse(sessionStorage.getItem('metromile-last-mile-request') || 'null');
    return saved && typeof saved.id === 'string' && typeof saved.station === 'string' ? saved : null;
  } catch {
    return null;
  }
}

function TaxiPilot({ station }) {
  const [destination, setDestination] = useState('');
  const [openToShare, setOpenToShare] = useState(false);
  const [requestIdentity, setRequestIdentity] = useState(savedLastMileRequest);
  const [feed, setFeed] = useState(null);
  const [message, setMessage] = useState('');
  const [clock, setClock] = useState(Date.now());
  const requestId = requestIdentity?.id;
  const requestStation = requestIdentity?.station;

  const refresh = useCallback(async () => {
    try {
      const params = new URLSearchParams({ station });
      if (requestId && requestStation === station) params.set('requestId', requestId);
      const response = await fetch(`/api/pilot-live?${params}`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      setFeed(data);
    } catch {
      setFeed(null);
      setMessage('The live pilot is unavailable. Check the connection.');
    }
  }, [requestId, requestStation, station]);

  useEffect(() => {
    refresh();
    const timer = window.setInterval(refresh, 3000);
    window.addEventListener('metromile-live-update', refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('metromile-live-update', refresh);
    };
  }, [refresh]);

  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const activeRequest = feed?.request;
    if (!activeRequest) return;
    if (!destination) {
      setDestination(activeRequest.destination);
      setOpenToShare(Boolean(activeRequest.shareCab));
    }
    if (activeRequest.status === 'matched' && activeRequest.shareMatch?.bothConfirmed) setMessage(`Both riders confirmed at ${activeRequest.shareMatch.meetingPoint}. Say code ${activeRequest.shareMatch.code}, confirm the destination in person, then take or book one cab together.`);
    else if (activeRequest.status === 'matched' && activeRequest.shareMatch?.yourConfirmed) setMessage(`You are checked in at ${activeRequest.shareMatch.meetingPoint}. Waiting for the other rider to confirm code ${activeRequest.shareMatch.code}.`);
    else if (activeRequest.status === 'matched' && activeRequest.shareMatch) setMessage(`Cab-share match: ${activeRequest.shareMatch.code}. Meet at ${activeRequest.shareMatch.meetingPoint}, then tap “I’m at the taxi bay.”`);
    else if (activeRequest.status === 'pending' && activeRequest.shareSearch?.phase === 'searching') setMessage(`Private cab-share search is running for ${activeRequest.destination}. Drivers cannot accept this as a solo pickup yet.`);
    else if (activeRequest.status === 'pending' && activeRequest.shareSearch?.phase === 'timed-out') setMessage(`Not enough riders are available to share ${activeRequest.destination} right now. Live drivers can now accept this request.`);
    else if (activeRequest.status === 'pending') setMessage(`Destination shared for ${activeRequest.destination}. Waiting for a taxi or feeder pilot.`);
    if (activeRequest.status === 'accepted' && activeRequest.acceptedBy === 'taxi' && ['taxi-share-reservation', 'taxi-share-pair'].includes(activeRequest.bookingType)) {
      const tripSeconds = Math.max(0, Math.ceil(((activeRequest.taxiTripStartsAt || clock) - clock) / 1000));
      setMessage(tripSeconds > 0 ? `A taxi reserved your cab-share seat to ${activeRequest.destination}. ${activeRequest.taxiRemainingSeats ?? 0} seat${activeRequest.taxiRemainingSeats === 1 ? '' : 's'} remain. The shared trip becomes ready in ${formatCountdown(tripSeconds)}.` : `Your shared taxi trip to ${activeRequest.destination} is ready with booked passengers. Meet at the station taxi bay.`);
    } else if (activeRequest.status === 'accepted' && activeRequest.acceptedBy === 'taxi') {
      setMessage(`A taxi accepted your direct ride to ${activeRequest.destination}. Meet the driver at the station taxi bay and confirm the fare before leaving.`);
    }
    if (activeRequest.status === 'accepted' && activeRequest.acceptedBy === 'feeder') setMessage(`Feeder ${activeRequest.routeName} manually accepted your trip to ${activeRequest.destination}. Confirm the drop-off with the driver before boarding.`);
  }, [clock, destination, feed?.request]);

  useEffect(() => {
    if (!requestId || !requestStation || requestStation === station) return;
    void sendPilot({ action: 'cancel-last-mile', requestId }).catch(() => {});
    sessionStorage.removeItem('metromile-last-mile-request');
    setRequestIdentity(null);
    setFeed(null);
    setDestination('');
    setOpenToShare(false);
    setMessage(`Station changed to ${station}. Enter and share a new final destination.`);
  }, [requestId, requestStation, station]);

  const shareDestination = async () => {
    if (!destination.trim()) {
      setMessage('Enter your final destination first.');
      return;
    }
    if (feed?.request?.status === 'accepted') {
      setMessage('This request was already accepted. Cancel it before starting another one.');
      return;
    }
    const nextRequestId = requestId || crypto.randomUUID();
    try {
      await sendPilot({ action: 'share-last-mile', requestId: nextRequestId, station, destination, shareCab: openToShare });
      const nextIdentity = { id: nextRequestId, station };
      sessionStorage.setItem('metromile-last-mile-request', JSON.stringify(nextIdentity));
      setRequestIdentity(nextIdentity);
      setMessage(openToShare ? 'Private one-minute cab-share search started. Drivers cannot accept a solo pickup during this minute.' : 'Destination shared. Waiting for a taxi or feeder pilot.');
      window.dispatchEvent(new Event('metromile-live-update'));
    } catch (error) {
      setMessage(error.message);
    }
  };

  const extendShareSearch = async () => {
    try {
      await sendPilot({ action: 'extend-share-search', requestId });
      setMessage('Private cab-share search extended for one more minute.');
      refresh();
    } catch (error) {
      setMessage(error.message);
    }
  };

  const confirmShareMeeting = async () => {
    try {
      await sendPilot({ action: 'confirm-share-meeting', requestId });
      setMessage('You are checked in at the taxi bay. Waiting for the other rider.');
      refresh();
    } catch (error) {
      setMessage(error.message);
    }
  };

  const cancelRequest = async () => {
    try {
      if (requestId) await sendPilot({ action: 'cancel-last-mile', requestId });
      sessionStorage.removeItem('metromile-last-mile-request');
      setRequestIdentity(null);
      setFeed(current => current ? { ...current, request: null } : current);
      setMessage('Last-mile request cancelled. Nothing was booked or charged.');
      window.dispatchEvent(new Event('metromile-live-update'));
    } catch (error) {
      setMessage(error.message);
    }
  };

  const availableTaxis = feed?.taxi.available || 0;
  const activeRequest = feed?.request;
  const shareMatch = activeRequest?.shareMatch;
  const shareSearch = activeRequest?.shareSearch;
  const shareSeconds = shareSearch ? Math.max(0, Math.ceil((shareSearch.endsAt - clock) / 1000)) : 0;
  const formattedShareTime = formatCountdown(shareSeconds);
  return (
    <section className="ride-card taxi-pilot-card">
      <span className="mini-label">SHARE YOUR LAST-MILE NEED</span>
      <h2>Continue from {station}</h2>
      <p className="pilot-summary">{availableTaxis ? `${availableTaxis} opt-in MetroMile taxi${availableTaxis > 1 ? 's' : ''} nearby` : `No opt-in MetroMile taxis sharing GPS near ${station} yet`}</p>
      <input value={destination} onChange={event => setDestination(event.target.value)} placeholder="Your final destination" maxLength="120" />
      <label className="share-cab-option"><input type="checkbox" checked={openToShare} onChange={event => setOpenToShare(event.target.checked)} /> <span><b>Open to share a cab</b><small>Runs a private 1-minute search for another rider at {station} with the same destination.</small></span></label>
      <button className="report-submit" onClick={shareDestination}>{activeRequest ? 'Update shared request' : 'Share destination with pilot drivers'}</button>
      {shareSearch?.phase === 'searching' && <div className="share-timer" aria-live="polite"><span>PRIVATE SHARE SEARCH</span><b>{formattedShareTime}</b><small>Drivers cannot accept this as a solo pickup while the timer runs.</small></div>}
      {shareSearch?.phase === 'timed-out' && <div className="share-timeout"><b>Not enough riders to share this destination right now.</b><small>Live drivers can now accept this solo pickup.</small></div>}
      {shareSearch?.phase === 'timed-out' && shareSearch.extensionsRemaining > 0 && <button className="request-control" onClick={extendShareSearch}>Search for one extra minute</button>}
      {shareMatch && !shareMatch.yourConfirmed && !shareMatch.bothConfirmed && <button className="request-control confirm-control" onClick={confirmShareMeeting}>I’m at the taxi bay</button>}
      {activeRequest && activeRequest.status !== 'accepted' && <button className="request-control cancel-control" onClick={cancelRequest}>Cancel request</button>}
      {activeRequest?.status === 'pending' && <p className="request-expiry">Active for about {Math.max(1, Math.ceil(activeRequest.expiresInSeconds / 60))} more minute{Math.ceil(activeRequest.expiresInSeconds / 60) === 1 ? '' : 's'}. Change the destination above, then update the request.</p>}
      <p className="fallback-note">Only opt-in taxi and feeder drivers who are live at {station} can see solo requests. A confirmed cab-share pair is shown only to live taxi pilots.</p>
      {message && <p className="pilot-message" aria-live="polite">{message}</p>}
    </section>
  );
}

function DriverPilot({ station }) {
  const [role, setRole] = useState('taxi');
  const [source, setSource] = useState(station);
  const [routeName, setRouteName] = useState('');
  const [feederDestination, setFeederDestination] = useState('');
  const [taxiCapacity, setTaxiCapacity] = useState('4');
  const [sharing, setSharing] = useState(false);
  const [feed, setFeed] = useState(null);
  const [message, setMessage] = useState('');
  const [clock, setClock] = useState(Date.now());
  const deviceId = pilotDeviceId(role);

  const refresh = useCallback(async () => {
    try {
      const params = new URLSearchParams({ station });
      if (sharing) params.set('driverId', deviceId);
      const response = await fetch(`/api/pilot-live?${params}`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      setFeed(data);
    } catch {
      setFeed(null);
      setMessage('Driver pilot is unavailable. Check the connection.');
    }
  }, [deviceId, sharing, station]);

  useEffect(() => {
    refresh();
    const timer = window.setInterval(refresh, 7000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!sharing) setSource(station);
  }, [sharing, station]);

  useEffect(() => {
    if (!sharing) return undefined;
    if (!navigator.geolocation) {
      setMessage('GPS is not supported by this browser.');
      setSharing(false);
      return undefined;
    }
    setMessage('Requesting GPS permission…');
    const watchId = navigator.geolocation.watchPosition(
      async position => {
        try {
          const update = await sendPilot({
            id: deviceId,
            role,
            station,
            source: role === 'feeder' ? source : undefined,
            routeName: role === 'feeder' ? routeName : undefined,
            destination: role === 'feeder' ? feederDestination : undefined,
            latitude: position.coords.latitude,
            longitude: position.coords.longitude,
            speedMps: position.coords.speed || 0,
            available: true,
            capacity: role === 'taxi' ? Number(taxiCapacity) : undefined
          });
          if (role === 'taxi') {
            setMessage(update.counted ? `You are available at ${station}. Waiting for passenger requests.` : `GPS is sharing, but you are ${update.distanceToStationKm} km from ${station}. You will receive passenger requests only within 3 km.`);
          } else {
            setMessage(`Broadcasting GPS status for ${routeName}.`);
          }
          window.dispatchEvent(new Event('metromile-live-update'));
          refresh();
        } catch (error) {
          setMessage(error.message || 'GPS update could not be sent.');
        }
      },
      () => setMessage('GPS permission is required for the pilot.'),
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 }
    );
    return () => navigator.geolocation.clearWatch(watchId);
  }, [deviceId, feederDestination, refresh, role, routeName, sharing, source, station, taxiCapacity]);

  const startSharing = () => {
    if (role === 'feeder' && (!source || !routeName.trim() || !feederDestination.trim())) {
      setMessage('Enter feeder source, route, and destination first.');
      return;
    }
    setSharing(true);
  };

  const acceptLastMileRequest = async item => {
    try {
      await sendPilot({ action: 'accept-last-mile', driverId: deviceId, ...(item.kind === 'shared' ? { shareMatchId: item.id } : { requestId: item.id }) });
      setMessage(item.kind === 'shared' ? 'Reserved two cab-share seats. The shared trip becomes ready when the search timer ends.' : item.kind === 'share-search' ? 'Reserved one cab-share seat. Wait for the search timer before starting the shared trip.' : role === 'taxi' ? 'Direct taxi ride accepted. Meet the passenger at the station taxi bay, then finish the ride before accepting another passenger.' : 'Feeder match confirmed. Meet the passenger at the station feeder bay.');
      refresh();
    } catch (error) {
      setMessage(error.message);
    }
  };

  const clearTaxiPool = async () => {
    try {
      await sendPilot({ action: 'clear-taxi-pool', driverId: deviceId });
      setMessage('Completed cab pool cleared. All seats are available for the next destination.');
      refresh();
    } catch (error) {
      setMessage(error.message);
    }
  };

  const completeTaxiDirectTrip = async () => {
    try {
      await sendPilot({ action: 'complete-taxi-direct-trip', driverId: deviceId });
      setMessage('Direct taxi ride completed. You can now accept the next passenger.');
      refresh();
    } catch (error) {
      setMessage(error.message);
    }
  };

  return (
    <details className="report-card driver-pilot-card">
      <summary><span className="mini-label">DRIVER & ATTENDANT PILOT</span><b>Are you a taxi or feeder driver?</b></summary>
      <div className="driver-pilot-content">
      <h2>Share a live station update</h2>
      <select value={role} onChange={event => setRole(event.target.value)} disabled={sharing}>
        <option value="taxi">Taxi driver — available for pickup</option>
        <option value="feeder">Feeder driver / attendant — boarding now</option>
      </select>
      {role === 'taxi' ? <div className="taxi-capacity-fields"><label htmlFor="taxi-capacity">Seats available in your cab</label><select id="taxi-capacity" value={taxiCapacity} onChange={event => setTaxiCapacity(event.target.value)} disabled={sharing}>{[1, 2, 3, 4, 5, 6].map(count => <option key={count} value={count}>{count} seat{count === 1 ? '' : 's'}</option>)}</select></div> : <div className="feeder-fields">
        <label>Pickup/source station</label>
        <select value={source} onChange={event => setSource(event.target.value)} disabled={sharing}>{stations.map(name => <option key={name}>{name}</option>)}</select>
        <label>Feeder route</label>
        <input value={routeName} onChange={event => setRouteName(event.target.value)} placeholder="e.g. K-1" maxLength="80" disabled={sharing} />
        <label>Destination</label>
        <input value={feederDestination} onChange={event => setFeederDestination(event.target.value)} placeholder="e.g. Thoppumpady" maxLength="80" disabled={sharing} />
      </div>}
      {!sharing ? <button className="driver-button" onClick={startSharing}>Go live with GPS</button> : <button className="stop-button" onClick={() => setSharing(false)}>Stop sharing</button>}
      {sharing && role === 'taxi' && feed?.driverCapacity?.directBooking && <><p className="taxi-seat-status"><b>Direct taxi ride booked:</b> {feed.driverCapacity.directBooking.destination} · Finish this ride before accepting another passenger.</p><button className="clear-pool-button" onClick={completeTaxiDirectTrip}>Finish direct taxi ride — accept next passenger</button></>}
      {sharing && role === 'taxi' && feed?.driverCapacity && !feed.driverCapacity.directBooking && <p className="taxi-seat-status"><b>Cab-share pool:</b> {feed.driverCapacity.reserved}/{feed.driverCapacity.capacity} seats reserved · {feed.driverCapacity.remaining} open{feed.driverCapacity.destination ? ` · To ${feed.driverCapacity.destination}` : ''}{feed.driverCapacity.trip.bookedPassengers > 0 ? feed.driverCapacity.trip.ready ? ' · Shared trip ready' : ` · Shared trip ready in ${formatCountdown(Math.max(0, Math.ceil((feed.driverCapacity.trip.tripStartsAt - clock) / 1000)))}` : ''}</p>}
      {sharing && role === 'taxi' && feed?.driverCapacity?.reserved > 0 && !feed.driverCapacity?.directBooking && <button className="clear-pool-button" onClick={clearTaxiPool}>End completed cab-share pool — free seats</button>}
      {sharing && <div className="driver-requests">
        <b>Passenger destination requests</b>
        {feed?.driverRequests?.length ? feed.driverRequests.map(item => {
          const shareSearchSeconds = item.kind === 'share-search' ? Math.max(0, Math.ceil((item.shareSearchEndsAt - clock) / 1000)) : 0;
          return <div className="pilot-pickup" key={item.id}><span>{item.kind === 'shared' ? `${item.riders} riders sharing to ${item.destination}` : item.kind === 'share-search' ? `Cab-share booking to ${item.destination} · Trip ready in ${formatCountdown(shareSearchSeconds)}` : `To ${item.destination}`}</span><button onClick={() => acceptLastMileRequest(item)}>{item.kind === 'shared' ? 'Reserve shared seats' : item.kind === 'share-search' ? 'Reserve 1 seat' : role === 'taxi' ? 'Add 1 rider' : 'Confirm feeder match'}</button></div>;
        }) : <span>No requests available for pickup at this station.</span>}
      </div>}
      {message && <p className="pilot-message" aria-live="polite">{message}</p>}
      </div>
    </details>
  );
}

export function App() {
  const [station, setStation] = useState('Vyttila');
  const [crisis, setCrisis] = useState(false);

  return (
    <main className={`sprint-app ${crisis ? 'crisis' : ''}`}>
      {crisis && <div className="crisis-banner">⚠ Technical breakdown at MG Road station. Rerouting via North Overbridge KSRTC buses.</div>}
      <header className="sprint-header">
        <div><span className="mini-label">KOCHI LAST-MILE PILOT</span><h1>Metro<span>Mile</span></h1></div>
        <span className="online-pill">● Pilot mode</span>
      </header>
      <section className="station-picker">
        <label htmlFor="exit-station">Your Metro exit station</label>
        <select id="exit-station" value={station} onChange={event => setStation(event.target.value)}>{stations.map(name => <option key={name}>{name}</option>)}</select>
        <small>This is where you leave the Metro and begin your last-mile trip.</small>
      </section>
      <TaxiPilot station={station} />
      <TransferSummary station={station} />
      <DriverPilot station={station} />
      <button className="crisis-trigger" onClick={() => setCrisis(value => !value)}>{crisis ? 'Reset demo' : 'Simulate February 25th Crisis'}</button>
    </main>
  );
}

const appRoot = document.getElementById('root');
if (appRoot) createRoot(appRoot).render(<App />);
