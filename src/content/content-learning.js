class ContentLearning {
  constructor({ ai } = {}) { this.ai = ai || require('../ai/ai-runtime'); }
  async explain(report) {
    const result = await this.ai.callAi([
      'Return ONLY JSON {"observations":[{"text":"...","postIds":["..."]}],"hypotheses":["..."],"nextExperiment":"..."}. No tools.',
      'Explain the supplied same-platform, age-matched descriptive results. Cite only supplied post IDs. Never infer sales, causal effects or statistical significance. Mark suggested explanations as hypotheses. Missing metrics are unknown. Application code decides topic selection, cadence and selling rules; do not override them.',
      JSON.stringify({ objective: report.objective, platforms: report.platforms, eligible: report.eligible.slice(-80) })
    ].join('\n'), { taskType: 'CONTENT_ANALYSIS' });
    const ids = new Set(report.eligible.map(p => p.id));
    if (!Array.isArray(result?.observations) || !Array.isArray(result.hypotheses) || typeof result.nextExperiment !== 'string' || result.hypotheses.some(h => typeof h !== 'string') || result.observations.some(o => typeof o.text !== 'string' || !Array.isArray(o.postIds) || !o.postIds.length || o.postIds.some(id => !ids.has(id)))) throw new Error('Learning explanation contains invalid evidence');
    return result;
  }
}
module.exports = { ContentLearning };
