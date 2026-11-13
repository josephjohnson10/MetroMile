// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { App } from './main.jsx';

const emptyFeed = {
  source: 'MetroMile pilot devices',
  feeder: { services: [] },
  taxi: { available: 0 },
  request: null,
  driverRequests: [],
  driverCapacity: null,
  expiresInSeconds: 90
};

function jsonResponse(body) {
  return { ok: true, json: async () => body };
}

describe('MetroMile current UI flows', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    vi.stubGlobal('fetch', vi.fn(async (url, options = {}) => {
      if (options.method === 'POST') return jsonResponse({ ok: true });
      const request = String(url).includes('requestId=') ? {
        status: 'pending',
        station: 'Vyttila',
        destination: 'Vyttila Mobility Hub',
        shareCab: true,
        shareSearch: { phase: 'searching', endsAt: Date.now() + 60_000, secondsRemaining: 60, driverVisible: false },
        shareMatch: null,
        expiresInSeconds: 300,
        acceptedBy: null,
        routeName: null,
        feederDestination: null,
        taxiCapacity: null,
        taxiReservedSeats: null,
        taxiRemainingSeats: null,
        taxiTripStartsAt: null
      } : null;
      return jsonResponse({ ...emptyFeed, request });
    }));
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('updates the dashboard when the rider selects another exit station', () => {
    render(<App />);

    fireEvent.change(screen.getByLabelText('Your Metro exit station'), { target: { value: 'Edappally' } });

    expect(screen.getByRole('heading', { name: 'Edappally: your next move' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Continue from Edappally' })).toBeInTheDocument();
  });

  it('starts a visible private one-minute cab-share search after the rider submits', async () => {
    render(<App />);

    fireEvent.change(screen.getByPlaceholderText('Your final destination'), { target: { value: 'Vyttila Mobility Hub' } });
    fireEvent.click(screen.getByRole('checkbox', { name: /open to share a cab/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Share destination with pilot drivers' }));

    expect(await screen.findByText('PRIVATE SHARE SEARCH')).toBeInTheDocument();
    expect(screen.getByText(/Drivers cannot accept this as a solo pickup while the timer runs/i)).toBeInTheDocument();
  });

  it('does not create a request until the rider enters a final destination', () => {
    render(<App />);

    fireEvent.click(screen.getByRole('button', { name: 'Share destination with pilot drivers' }));

    expect(screen.getByText('Enter your final destination first.')).toBeInTheDocument();
    expect(vi.mocked(fetch).mock.calls.some(([, options]) => options?.method === 'POST')).toBe(false);
  });

  it('keeps a taxi-reserved share request locked and shows its countdown', async () => {
    sessionStorage.setItem('metromile-last-mile-request', JSON.stringify({ id: 'rider-1', station: 'Vyttila' }));
    vi.mocked(fetch).mockImplementation(async (url, options = {}) => {
      if (options.method === 'POST') return jsonResponse({ ok: true });
      const request = String(url).includes('requestId=rider-1') ? {
        status: 'accepted',
        station: 'Vyttila',
        destination: 'Vyttila Mobility Hub',
        shareCab: true,
        shareSearch: null,
        shareMatch: null,
        expiresInSeconds: 300,
        acceptedBy: 'taxi',
        routeName: null,
        feederDestination: null,
        taxiCapacity: 4,
        taxiReservedSeats: 1,
        taxiRemainingSeats: 3,
        taxiTripStartsAt: Date.now() + 60_000,
        bookingType: 'taxi-share-reservation'
      } : null;
      return jsonResponse({ ...emptyFeed, request });
    });

    render(<App />);

    expect(await screen.findByText(/A taxi reserved your cab-share seat to Vyttila Mobility Hub/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel request' })).not.toBeInTheDocument();
  });

  it('shows a direct taxi confirmation, never a shared-trip countdown, when cab sharing was not selected', async () => {
    sessionStorage.setItem('metromile-last-mile-request', JSON.stringify({ id: 'rider-direct', station: 'Vyttila' }));
    vi.mocked(fetch).mockImplementation(async (url, options = {}) => {
      if (options.method === 'POST') return jsonResponse({ ok: true });
      const request = String(url).includes('requestId=rider-direct') ? {
        status: 'accepted',
        station: 'Vyttila',
        destination: 'CUSAT',
        shareCab: false,
        shareSearch: null,
        shareMatch: null,
        expiresInSeconds: 300,
        acceptedBy: 'taxi',
        routeName: null,
        feederDestination: null,
        taxiCapacity: null,
        taxiReservedSeats: null,
        taxiRemainingSeats: null,
        taxiTripStartsAt: null,
        bookingType: 'taxi-direct'
      } : null;
      return jsonResponse({ ...emptyFeed, request });
    });

    render(<App />);

    expect(await screen.findByText(/A taxi accepted your direct ride to CUSAT/i)).toBeInTheDocument();
    expect(screen.queryByText(/shared trip becomes ready|pooled trip becomes ready/i)).not.toBeInTheDocument();
  });

  it('gives a clear message when live driver GPS is unsupported', async () => {
    const originalGeolocation = navigator.geolocation;
    Object.defineProperty(navigator, 'geolocation', { configurable: true, value: undefined });

    try {
      render(<App />);
      fireEvent.click(screen.getByRole('button', { name: 'Go live with GPS' }));

      expect(await screen.findByText('GPS is not supported by this browser.')).toBeInTheDocument();
    } finally {
      Object.defineProperty(navigator, 'geolocation', { configurable: true, value: originalGeolocation });
    }
  });

  it('keeps taxi capacity selectable before a driver goes live', () => {
    render(<App />);

    expect(screen.getByLabelText('Seats available in your cab')).toHaveValue('4');
    expect(screen.getByRole('button', { name: 'Go live with GPS' })).toBeInTheDocument();
  });

  it('activates and resets the crisis demo banner', () => {
    render(<App />);

    fireEvent.click(screen.getByRole('button', { name: 'Simulate February 25th Crisis' }));
    expect(screen.getByText(/Technical breakdown at MG Road station/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Reset demo' }));
    expect(screen.queryByText(/Technical breakdown at MG Road station/i)).not.toBeInTheDocument();
  });
});
