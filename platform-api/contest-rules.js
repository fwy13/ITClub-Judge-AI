export function effectiveContestStatus(contest, now = new Date()) {
    if (!contest) return 'closed';
    if (contest.status === 'ended') return 'ended';
    if (contest.status === 'open' && contest.end_at && new Date(contest.end_at) <= now) return 'ended';
    return contest.status || 'closed';
}

export function roleCanEnterContest(type, role) {
    if (role === 'admin') return true;
    return type === 'csv' ? role === 'team' : role === 'student';
}

export function contestAcceptsSubmissions(contest, now = new Date()) {
    return effectiveContestStatus(contest, now) === 'open'
        && new Date(contest.start_at) <= now
        && new Date(contest.end_at) > now;
}

export function contestProblemLabel(index) {
    let value = Number(index) + 1;
    let label = '';
    while (value > 0) {
        value -= 1;
        label = String.fromCharCode(65 + (value % 26)) + label;
        value = Math.floor(value / 26);
    }
    return label;
}
