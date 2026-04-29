/**
 * Maps Routes API v2 `computeRoutes` JSON into Google Maps Javascript
 * DirectionsResult-shaped objects consumed by driver authorization single-page flow.
 *
 * Depends on google.maps.geometry.encoding for encoded polylines (loaded with Maps API).
 */

(function () {
    'use strict';

    /** @param {string|undefined} d */
    function parseProtoDurationSeconds(d) {
        if (!d || typeof d !== 'string') return 0;
        const m = d.match(/^([\d.]+)s$/);
        return m ? Math.round(parseFloat(m[1], 10)) : 0;
    }

    function formatDurText(seconds) {
        if (seconds <= 0) return '0 min';
        const min = Math.max(1, Math.round(seconds / 60));
        if (min < 60) return `${min} mins`;
        const h = Math.floor(min / 60);
        const r = min % 60;
        return r ? `${h} hour ${r} mins` : `${h} hour`;
    }

    function formatDistText(meters) {
        if (meters == null || meters <= 0) return '';
        const km = meters / 1000;
        if (km < 0.1) return `${Math.round(meters)} m`;
        return `${km.toFixed(1)} km`;
    }

    /** Routes API Vehicle.type -> Directions-style vehicle icon enum */
    function mapTransitVehicleEnum(vtRaw) {
        const t = (vtRaw || '').toString().toUpperCase();
        if (!t || t.includes('BUS')) return 'BUS';
        if (t === 'SUBWAY') return 'SUBWAY';
        if (t.includes('MONORAIL') || t.includes('TRAM')) return 'TRAIN';
        if (
            t.includes('TRAIN') ||
            t.includes('RAIL') ||
            t === 'HEAVY_RAIL' ||
            t === 'COMMUTER_TRAIN' ||
            t === 'LIGHT_RAIL' ||
            t === 'HIGH_SPEED_TRAIN'
        )
            return 'TRAIN';
        return 'TRANSIT';
    }

    /**
     * @param {unknown} stop
     * @param {typeof google.maps.LatLng} LatLngCtor
     */
    function stopToDirectionsStop(stop, LatLngCtor) {
        if (!stop) return undefined;
        const locObj = stop.location && stop.location.latLng;
        let loc = undefined;
        if (locObj && typeof locObj.latitude === 'number' && typeof locObj.longitude === 'number') {
            loc = new LatLngCtor(locObj.latitude, locObj.longitude);
        }
        return {
            name: stop.name || stop.displayName?.text || '',
            location: loc,
        };
    }

    /** @param {*} td */
    /** @param {typeof google.maps.LatLng} LatLngCtor */
    function transitDetailsToDirectionsTransit(td, LatLngCtor) {
        const line = td.transitLine || td.transit_line || {};
        const tl = td.transitLines && td.transitLines[0];
        const ln = tl || line;
        const vtype = ln.vehicle?.type ?? ln.vehicleType;
        const stopDetails = td.stopDetails || td.stop_details;
        let depStop = stopDetails?.departureStop || stopDetails?.departure_stop;
        let arrStop = stopDetails?.arrivalStop || stopDetails?.arrival_stop;
        if (!depStop) depStop = td.departureStop;
        if (!arrStop) arrStop = td.arrivalStop;

        const depIso = td.departureTime || td.departure_time?.value;
        const arrIso = td.arrivalTime || td.arrival_time?.value;
        /** @returns {number|undefined} unix seconds */
        function secs(v) {
            if (v == null) return undefined;
            if (typeof v === 'number' && Number.isFinite(v))
                return v > 2e12 ? Math.floor(v / 1000) : Math.floor(v);
            const p = typeof v === 'string' ? Date.parse(v) : NaN;
            return Number.isFinite(p) ? Math.floor(p / 1000) : undefined;
        }

        const headsignln = ln.localizedHeadsign ?? ln.headsign;
        let headsign = '';
        if (typeof headsignln === 'string') headsign = headsignln;
        else if (headsignln && typeof headsignln === 'object') headsign = headsignln.text || '';

        let color = ln.color ?? '';
        if (color && !String(color).startsWith('#'))
            color = String(color).replace(/^#/, '').length <= 8 ? '#' + color : color;

        return {
            headsign,
            headway: td.headway ?? undefined,
            num_stops: td.stopCount != null ? td.stopCount : td.num_stops ?? undefined,
            departure_time: secs(depIso)
                ? { text: '', value: /** @type number */ secs(depIso) }
                : undefined,
            arrival_time: secs(arrIso)
                ? { text: '', value: /** @type number */ secs(arrIso) }
                : undefined,
            departure_stop: stopToDirectionsStop(depStop, LatLngCtor),
            arrival_stop: stopToDirectionsStop(arrStop, LatLngCtor),
            line: {
                name: ln.name ?? ln.longName?.text ?? ln.shortName ?? '',
                short_name: ln.nameShort ?? ln.shortName ?? ln.short_name ?? '',
                color: color || (ln.colorHex ? String(ln.colorHex) : ''),
                agencies: Array.isArray(ln.agencies)
                    ? ln.agencies.map((a) => ({ name: a.name || '', url: a.uri || '' }))
                    : [],
                vehicle: {
                    type: mapTransitVehicleEnum(vtype),
                    name: ln.vehicle?.name?.text ?? ln.vehicle?.name ?? '',
                },
            },
        };
    }

    /**
     * @param {*} location
     * @param {typeof google.maps.LatLng} LatLngCtor
     */
    function locationToLatLng(location, LatLngCtor) {
        const ll =
            location && location.latLng
                ? location.latLng
                : location?.latlng || location?.lat_lng || null;
        if (!ll || typeof ll.latitude !== 'number' || typeof ll.longitude !== 'number') return null;
        return new LatLngCtor(ll.latitude, ll.longitude);
    }

    /** @param {*} step */
    /** @param {typeof google.maps.LatLng} LatLngCtor */
    function adaptStep(step, LatLngCtor) {
        const staticDurSec = parseProtoDurationSeconds(step.staticDuration);
        const dm = step.distanceMeters != null ? step.distanceMeters : 0;
        const tm = step.travelMode || step.travel_mode || 'UNKNOWN';

        const tmUpper = String(tm).toUpperCase();
        /** @type {'WALKING'|'TRANSIT'} */
        let travel_mode = tmUpper.includes('TRANSIT')
            ? 'TRANSIT'
            : 'WALKING';

        const base = {
            travel_mode,
            duration: {
                value: staticDurSec,
                text: formatDurText(staticDurSec),
            },
            distance: {
                value: dm,
                text: formatDistText(dm),
            },
            start_location: locationToLatLng(step.startLocation, LatLngCtor),
            end_location: locationToLatLng(step.endLocation, LatLngCtor),
        };

        const enc = step.polyline && step.polyline.encodedPolyline;
        if (enc) base.polyline = { points: enc };

        if (travel_mode === 'TRANSIT' && step.transitDetails) {
            base.transit = transitDetailsToDirectionsTransit(step.transitDetails, LatLngCtor);
        }

        return base;
    }

    /** @param {*} leg */
    /** @param {typeof google.maps.LatLng} LatLngCtor */
    function adaptLeg(leg, LatLngCtor) {
        let durSec = parseProtoDurationSeconds(leg.duration);
        let distM = leg.distanceMeters != null ? leg.distanceMeters : 0;

        /** @type {Array<*>} */
        const rawSteps = leg.steps || [];
        const steps = rawSteps.map((s) => adaptStep(s, LatLngCtor));
        if (durSec <= 0 && steps.length) {
            durSec = steps.reduce((s, z) => s + ((z.duration && z.duration.value) || 0), 0);
        }
        if (distM <= 0 && steps.length) {
            distM = steps.reduce((s, z) => s + ((z.distance && z.distance.value) || 0), 0);
        }

        let start_location = locationToLatLng(leg.startLocation, LatLngCtor);
        let end_location = locationToLatLng(leg.endLocation, LatLngCtor);
        if (!start_location && steps[0] && steps[0].start_location) start_location = steps[0].start_location;
        if (!end_location && steps.length) {
            const last = steps[steps.length - 1];
            if (last && last.end_location) end_location = last.end_location;
        }

        return {
            duration: {
                value: durSec,
                text: formatDurText(durSec),
            },
            distance: {
                value: distM,
                text: formatDistText(distM),
            },
            start_location,
            end_location,
            steps,
        };
    }

    /** @param {*} route */
    /** @param {typeof google.maps.LatLng} LatLngCtor */
    function adaptRoutesApiRouteToDirectionsResponse(route, LatLngCtor) {
        const legs = (route.legs || []).map((leg) => adaptLeg(leg, LatLngCtor));
        let overview = undefined;
        if (route.polyline && route.polyline.encodedPolyline) {
            overview = { points: route.polyline.encodedPolyline };
        }
        /** @type {google.maps.DirectionsResult} minimal */
        return {
            geocoded_waypoints: [],
            routes: [
                {
                    legs,
                    overview_polyline: overview,
                    summary: '',
                    copyrights:
                        typeof route.routeLabels?.join === 'function'
                            ? route.routeLabels.join(', ')
                            : '',
                },
            ],
            request: undefined,
            status: 'OK',
        };
    }

    /** @type {typeof window} x */
    const x =
        typeof window !== 'undefined' ? /** @type {any} */ (window) : /** @type {any} */ ({});

    /**
     * @param {unknown[]} routesArray Top-level Routes API routes array
     * @param {typeof google.maps.LatLng} LatLngCtor
     */
    x.routesApiAdaptAuthorizationRoutes = function routesApiAdaptAuthorizationRoutes(
        routesArray,
        LatLngCtor,
    ) {
        const arr = Array.isArray(routesArray) ? routesArray : [];
        return arr.map((r) => adaptRoutesApiRouteToDirectionsResponse(r, LatLngCtor));
    };

})();
