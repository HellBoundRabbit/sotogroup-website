/**
 * Availability feature: template + calendar overrides (Option A).
 * Driver template on user: availabilityType, availabilityWorkingDays, availabilityStandbyDays.
 * Calendar doc per date: drivers[driverId] = { status, editedByDriver?, editedByOffice?, seenByOffice?, seenByDriver? }.
 * Days are Mon–Fri only (0=Mon .. 4=Fri).
 */

(function (global) {
    'use strict';

    const STATUS = { WORKING: 'working', STANDBY: 'standby', OFF: 'off' };
    const AVAILABILITY_TYPE = { FULL: 'full', PART: 'part', STANDBY: 'standby' };

    /** Parse YYYY-MM-DD as local date (avoids UTC-midnight timezone bug where Monday can appear as Sunday in timezones behind UTC). */
    function parseLocalDate(dateOrStr) {
        if (dateOrStr instanceof Date) return dateOrStr;
        const s = String(dateOrStr || '');
        const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
        if (m) return new Date(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10));
        return new Date(dateOrStr);
    }

    /** Monday=0, Tuesday=1, ..., Friday=4. Weekend returns -1. */
    function getWeekdayIndex(date) {
        const d = parseLocalDate(date);
        const day = d.getDay(); // 0=Sun, 1=Mon, ..., 6=Sat
        if (day === 0 || day === 6) return -1;
        return day - 1; // Mon=0 .. Fri=4
    }

    /** YYYY-MM-DD for a Date. */
    function toDateString(date) {
        const d = parseLocalDate(date);
        return d.getFullYear() + '-' +
            String(d.getMonth() + 1).padStart(2, '0') + '-' +
            String(d.getDate()).padStart(2, '0');
    }

    /**
     * Derive effective status for a driver on a date from template only (no override).
     * template: { availabilityType, availabilityWorkingDays?, availabilityStandbyDays? }
     * availabilityWorkingDays, availabilityStandbyDays: arrays of 0..4 (Mon–Fri).
     */
    function statusFromTemplate(template, date) {
        const wd = getWeekdayIndex(date);
        if (wd < 0) return STATUS.OFF; // weekend
        const type = (template && template.availabilityType) || AVAILABILITY_TYPE.FULL;
        const working = template && Array.isArray(template.availabilityWorkingDays) ? template.availabilityWorkingDays : [];
        const standby = template && Array.isArray(template.availabilityStandbyDays) ? template.availabilityStandbyDays : [];

        if (type === AVAILABILITY_TYPE.FULL) {
            return STATUS.WORKING; // Mon–Fri all working
        }
        if (type === AVAILABILITY_TYPE.PART) {
            if (working.indexOf(wd) >= 0) return STATUS.WORKING;
            if (standby.indexOf(wd) >= 0) return STATUS.STANDBY;
            return STATUS.OFF;
        }
        if (type === AVAILABILITY_TYPE.STANDBY) {
            if (working.indexOf(wd) >= 0) return STATUS.WORKING;
            if (standby.indexOf(wd) >= 0) return STATUS.STANDBY;
            return STATUS.OFF;
        }
        return STATUS.OFF;
    }

    /**
     * Get effective status for a driver on a date: override in calendar doc wins, else template.
     * calendarDriverEntry: { status?, editedByDriver?, editedByOffice?, seenByOffice?, seenByDriver? } or null.
     */
    function getEffectiveStatus(template, calendarDriverEntry, date) {
        if (calendarDriverEntry && calendarDriverEntry.status) {
            return calendarDriverEntry.status;
        }
        return statusFromTemplate(template, date);
    }

    /**
     * Check if a date is inside the 7-day lock window (today + next 6 days). Only office can change these.
     */
    function isInLockWindow(date) {
        const d = parseLocalDate(date);
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        d.setHours(0, 0, 0, 0);
        const daysFromToday = Math.round((d - today) / (1000 * 60 * 60 * 24));
        return daysFromToday >= 0 && daysFromToday <= 6;
    }

    /**
     * Build driver template from user/doc fields.
     */
    function getDriverTemplate(userOrDriver) {
        if (!userOrDriver) return null;
        return {
            availabilityType: userOrDriver.availabilityType || AVAILABILITY_TYPE.FULL,
            availabilityWorkingDays: Array.isArray(userOrDriver.availabilityWorkingDays) ? userOrDriver.availabilityWorkingDays : [],
            availabilityStandbyDays: Array.isArray(userOrDriver.availabilityStandbyDays) ? userOrDriver.availabilityStandbyDays : []
        };
    }

    /**
     * Check if driver type (availability) is set. Used for "profile complete" when postcode+photo exist but type missing.
     */
    function hasDriverTypeSet(userOrDriver) {
        if (!userOrDriver) return false;
        const t = userOrDriver.availabilityType;
        if (!t || (t !== AVAILABILITY_TYPE.FULL && t !== AVAILABILITY_TYPE.PART && t !== AVAILABILITY_TYPE.STANDBY)) return false;
        if (t === AVAILABILITY_TYPE.FULL) return true;
        // Part/Standby: we don't require days to be set for "type set" (days can be empty)
        return true;
    }

    global.AvailabilityModel = {
        STATUS,
        AVAILABILITY_TYPE,
        parseLocalDate,
        getWeekdayIndex,
        toDateString,
        statusFromTemplate,
        getEffectiveStatus,
        isInLockWindow,
        getDriverTemplate,
        hasDriverTypeSet
    };
})(typeof window !== 'undefined' ? window : this);
