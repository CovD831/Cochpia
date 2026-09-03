export function createApprovalRegistry({ pendingApprovals, approvalRecords, sessionApprovalGrants, currentUserId, approvalTimeoutMs, sessionApprovalGrantTtlMs }) {
  const waitForApproval = (runId, toolCallId, { risk = 'execute', sessionId = null } = {}) => {
    const grantKey = `${currentUserId()}:${sessionId || ''}:${risk}`;
    const grant = sessionApprovalGrants.get(grantKey);
    if (risk === 'write' && grant) {
      if (grant.expiresAt > Date.now()) return Promise.resolve({ approved: true, decision: 'acceptForSession' });
      sessionApprovalGrants.delete(grantKey);
    }
    return new Promise(resolve => {
      const key = `${runId}:${toolCallId}`;
      const record = { runId, toolCallId, risk, sessionId, approvalStage: 1, status: 'pending', approved: null, ownerId: currentUserId(), createdAt: new Date().toISOString(), resolve };
      record.timer = setTimeout(() => { pendingApprovals.delete(key); approvalRecords.delete(key); record.status = 'expired'; resolve({ approved: false, decision: 'timeout' }); }, approvalTimeoutMs);
      pendingApprovals.set(key, record);
      approvalRecords.set(key, record);
    });
  };

  const respondApproval = (req, res, fail) => {
    const { runId, toolCallId, approved } = req.body || {};
    const key = `${runId}:${toolCallId}`;
    const record = approvalRecords.get(key);
    if (!record || record.ownerId !== currentUserId()) return fail(res, 404, 'APPROVAL_NOT_FOUND', 'Approval request not found or expired');
    const acceptForSession = req.body?.acceptForSession === true;
    const requestedDecision = String(req.body?.decision || '');
    const decision = ['allow', 'interrupt', 'deny'].includes(requestedDecision)
      ? requestedDecision
      : approved === true ? 'allow' : 'deny';
    const allowed = decision === 'allow';
    if (allowed && record.risk === 'deploy' && record.approvalStage === 1) {
      record.approvalStage = 2;
      clearTimeout(record.timer);
      record.timer = setTimeout(() => { pendingApprovals.delete(key); approvalRecords.delete(key); record.status = 'expired'; record.resolve({ approved: false, decision: 'timeout' }); }, approvalTimeoutMs);
      return res.json({ ok: true, awaitingSecondApproval: true, risk: record.risk });
    }
    if (record.status === 'decided') {
      if (record.decision !== decision) return fail(res, 409, 'APPROVAL_ALREADY_DECIDED', 'Approval request already has a different decision');
      return res.json({ ok: true, approved: record.approved, decision, idempotent: true });
    }
    record.status = 'decided';
    record.decision = decision;
    record.approved = allowed;
    record.feedback = String(req.body?.feedback || '').trim().slice(0, 4000) || null;
    clearTimeout(record.timer);
    pendingApprovals.delete(key);
    if (allowed && acceptForSession && record.risk === 'write') sessionApprovalGrants.set(`${record.ownerId}:${record.sessionId || ''}:write`, { expiresAt: Date.now() + sessionApprovalGrantTtlMs });
    record.resolve({ approved: allowed, decision, feedback: record.feedback });
    return res.json({ ok: true, approved: allowed, decision, feedback: record.feedback });
  };

  const approvalGrantCleanup = setInterval(() => { const now = Date.now(); for (const [key, grant] of sessionApprovalGrants) if (grant.expiresAt <= now) sessionApprovalGrants.delete(key); }, 10 * 60 * 1000);
  approvalGrantCleanup.unref?.();

  return { waitForApproval, respondApproval };
}
