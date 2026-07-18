# MetroMile — Kochi Sync

> Last-mile confidence for Kochi Metro commuters.

**MetroMile** is a mobile-first, local-first transfer dashboard that synchronizes a passenger's metro journey with feeder buses, auto availability, local ride-hailing options, and disruption signals at their destination. It is designed to turn the uncertainty after a train journey into one clear next action.

Built for the **OpenAI Build Week — Codex Nightline Hackathon** on an M2 Mac with React, Vite, Tailwind CSS, and OpenAI's Responses API.

## The problem

Kochi Metro passengers often arrive at a station without knowing whether a feeder bus is close, autos are actually waiting, or road construction has made the usual last-mile route unreliable. During a major disruption, official updates can lag behind the commuter's immediate need to leave the station.

MetroMile focuses on the "last-mile anxiety" in that gap: show the relevant connection, warn about the route, and provide a fast fallback.

## Core experience

### One-glance transfer dashboard

The primary screen uses large, high-priority information: an imminent feeder countdown, the correct exit/platform, available autos, metro status, and a compact live feeder board. The app is intentionally designed for a passenger who has only a few seconds to decide where to walk.

### Smart auto aggregator

MetroMile compares a local, zero-commission option such as **Yatri** with a conventional ride-hailing option such as Uber. It can recommend the local open network when the estimated fare and cancellation risk are better for the passenger.

### Construction bypass alert

The dashboard surfaces localized alerts for difficult last-mile corridors, such as the Seaport–Airport Road congestion around JLN Stadium during the Pink Line / Phase 2 expansion. The alert points commuters to practical alternatives such as the CUSAT feeder rather than offering a generic road-blocked warning.

### Opt-in Pod

Passengers heading to the same destination can opt into a lightweight ride-share match. The prototype simulates a match with a precise handoff point—such as **Pillar 412, Exit 2**—to eliminate the coordination friction that makes informal shared rides fail.

### Crowd-Sense engine

Commuters can report a situation in natural language: “Heavy crowd near CUSAT feeder; autos are not moving.” Crowd-Sense converts that unstructured report into a normalized signal with:

- severity: low, medium, or high
- category: metro, traffic, last-mile, or general
- location
- concise summary

The UI works offline with a local fallback parser. When configured with an API key, it makes one OpenAI Responses API request using strict JSON schema output. This is intentionally an AI utility workflow—not a generic chatbot—and gives a city dashboard clean data it can act on.

### Evac / disruption demo mode

The **Demo: Evac** control changes the experience into a high-urgency disruption overlay. It highlights the affected service and an immediate alternative such as a KSRTC bus route, demonstrating how MetroMile could be useful before delayed official announcements reach stranded commuters.

## Why it works in the real world

| Challenge | MetroMile response |
| --- | --- |
| Phase 2 / Pink Line construction creates unpredictable road diversions | Localized bypass alerts guide travellers toward unaffected feeder routes, including alternatives such as CUSAT. |
| Peak-hour breakdowns create exit bottlenecks and confusion | Disruption mode promotes a clear evacuation or feeder fallback immediately. |
| Passengers do not want another large native app | A lightweight, mobile-first web app can be opened through a QR code, URL, or deep link from KMRL's existing ticketing flow. |
| Cellular dead zones interrupt live information | Essential UI data is local and cached, so the transfer board stays useful through short network drops. |
| Driver telemetry may be missing or unreliable | Crowd-Sense supplies a human-in-the-loop fallback for auto availability and local hazards. |

## Architecture

```text
Local data.json ──> React transfer dashboard ──> commuter action
                         │
                         ├── simulated ride-share match (setTimeout)
                         └── Crowd-Sense text report
                                  │
                         local demo parser OR one Responses API request
                                  │
                         strict structured JSON signal
```

The sprint prototype intentionally avoids a database, WebSockets, payment flows, and fabricated real-time integrations. Transit timings, fares, and availability are stored in `src/data.json`; the UI is therefore quick to load and resilient during a brief offline period. In a production rollout, the same frontend could consume live ONDC/Yatri, KMRL, feeder, and city-operations APIs through secure server-side services.

## Scale potential

MetroMile is not limited to an individual phone screen. The same React interface could support KMRL's in-coach display screens, broadcasting feeder and disruption information to all passengers—including those without a smartphone. For ticketing, it favors deep links into existing KMRL / WhatsApp infrastructure instead of adding an unnecessary payment system.

## Run locally

```bash
npm install
npm run dev
```

Open the local address Vite prints, normally `http://127.0.0.1:5173` or the next available port.

## AI demo setup

Without configuration, Crowd-Sense uses a local demo parser so the prototype remains functional offline. To enable the OpenAI Responses API call, create `.env.local`:

```bash
VITE_OPENAI_API_KEY=your_key_here
VITE_OPENAI_MODEL=gpt-5.6
```

> `VITE_*` values are exposed to the browser. This is suitable only for a controlled hackathon demo; a production deployment must put the OpenAI request behind a server-side endpoint and keep the API key secret.

## Sprint scope and next steps

**Current prototype:** mobile dashboard, static local transit data, disruption demo, mocked pod match, local fallback parser, and optional structured AI parsing.

**Next:** connect verified KMRL and feeder feeds, add an ONDC/Yatri adapter, use a secure backend proxy for AI parsing, introduce moderation/rate limits for public reports, and validate the route recommendations with local commuters and operators.
