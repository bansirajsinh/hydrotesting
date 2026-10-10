const { getDb } = require('../db');
async function audit({ entityType, entityId, action, actorId = 'demo-operator', reason = null, before = null, after = null, correlationId = null }) {
  await getDb().collection('auditLogs').insertOne({ entityType, entityId: String(entityId), action, actorId, reason, before, after, correlationId, createdAt: new Date() });
}
module.exports = { audit };
