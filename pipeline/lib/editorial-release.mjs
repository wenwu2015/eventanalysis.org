const LEGAL_BYPASS_CODES = new Set([
  "nexus_legal_pack_invalid",
  "agent_report_invalid_jurisdiction_decision",
  "agent_report_missing_jurisdiction_decisions",
  "agent_report_wrong_legal_pack_hashes",
]);

export function isLegalWorkflowFinding(finding = {}) {
  return LEGAL_BYPASS_CODES.has(String(finding?.code || "").trim());
}

export function summarizeEditorialReleaseReport(report = {}, requestedLocales = []) {
  const locales = [...new Set((requestedLocales || []).map((value) => String(value || "").trim()).filter(Boolean))];
  const findings = (report.findings || []).filter((finding) => !isLegalWorkflowFinding(finding));
  const ignoredFindings = (report.findings || []).filter((finding) => isLegalWorkflowFinding(finding));
  const hasBlock = findings.some((finding) => finding?.severity === "BLOCK");
  const hasReview = findings.some((finding) => finding?.severity === "REVIEW");
  const decision = hasBlock
    ? "BLOCK"
    : (report.riskClass !== "A" || report.decision === "REVIEW" || hasReview)
      ? "REVIEW"
      : "PASS";
  const allowedJurisdictions = (report.allowedJurisdictions || []).length
    ? [...new Set(report.allowedJurisdictions)]
    : (decision === "PASS" && locales.length === 1 && locales[0] === "zh")
      ? ["LOCAL_PREVIEW"]
      : [];
  return {
    ...report,
    decision,
    findings,
    ignoredFindings,
    allowedJurisdictions,
  };
}
