export const PERFECT_SCORE_BY_METRIC = Object.freeze({
    log_loss: 0,
    accuracy: 1,
    f1: 1,
    precision: 1,
    recall: 1,
    balanced_accuracy: 1,
    macro_f1: 1,
    micro_f1: 1,
    hamming_loss: 0,
    macro_precision: 1,
    macro_recall: 1,
    mae: 0,
    mse: 0,
    rmse: 0,
    r2: 1,
    mape: 0,
    smape: 0,
    sacrebleu: 100,
    chrf: 100,
    mrr: 1,
    map: 1,
    recall_at_k: 1,
    ndcg_at_k: 1,
});

export function perfectScoreForMetric(metric) {
    return PERFECT_SCORE_BY_METRIC[metric];
}

export function scoreScale(problem) {
    const config = problem?.config;
    if (!config || config.baseline_score == null) return null;
    const baseline = Number(config.baseline_score);
    const configuredPerfect = config.perfect_score;
    const perfect = configuredPerfect == null
        ? perfectScoreForMetric(config.metric || problem.metric)
        : Number(configuredPerfect);
    if (!Number.isFinite(baseline) || !Number.isFinite(perfect) || baseline === perfect) return null;
    const greaterIsBetter = Boolean(config.greater_is_better);
    if ((greaterIsBetter && perfect < baseline) || (!greaterIsBetter && perfect > baseline)) return null;
    return { baseline, perfect, greaterIsBetter };
}

export function normalizeMetricScore(rawScore, problem) {
    const raw = Number(rawScore);
    const scale = scoreScale(problem);
    if (!Number.isFinite(raw) || !scale) return null;
    const progress = (raw - scale.baseline) / (scale.perfect - scale.baseline);
    return Math.min(100, Math.max(0, progress * 100));
}
