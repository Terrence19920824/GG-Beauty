'use strict';

const TRANSITIONS = Object.freeze({
  pending: ['confirmed', 'cancelled'],
  confirmed: ['arrived', 'no_show', 'cancelled'],
  arrived: ['in_service'],
  in_service: ['completed'],
  completed: [], no_show: [], cancelled: []
});

const isKnownStatus = status => Object.prototype.hasOwnProperty.call(TRANSITIONS, status);
const canTransition = (fromStatus, toStatus) => fromStatus === toStatus || (isKnownStatus(fromStatus) && TRANSITIONS[fromStatus].includes(toStatus));
const recordStatusHistory = async (client, {appointment, fromStatus, toStatus, operatorType, operatorId, source, reason = null}) => {
  if (fromStatus === toStatus) return;
  await client.query(`INSERT INTO appointment_status_history (shop_id,appointment_id,from_status,to_status,operator_type,operator_id,source,reason) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [appointment.shop_id, appointment.id, fromStatus, toStatus, operatorType, operatorId || null, source, reason || null]);
};
module.exports = { TRANSITIONS, isKnownStatus, canTransition, recordStatusHistory };
