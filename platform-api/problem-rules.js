export function normalizeProblemText(value) {
    return String(value || '').replace(/\r\n?/g, '\n');
}

export function publicStarter(problem) {
    if (!problem || problem.kind !== 'code') return '';
    return normalizeProblemText(problem.starter);
}
