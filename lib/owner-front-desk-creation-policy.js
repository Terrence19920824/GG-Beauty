'use strict';

const getOwnerFrontDeskCreationPolicy = walkIn => walkIn === true
  ? {
      bookingSource: 'walk_in',
      historySource: 'owner_walk_in',
      transitions: ['confirmed', 'arrived']
    }
  : {
      bookingSource: 'owner_assisted',
      historySource: 'owner_assisted_booking',
      transitions: ['confirmed']
    };

module.exports = { getOwnerFrontDeskCreationPolicy };
