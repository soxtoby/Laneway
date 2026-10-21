/**
 * A commit's age in a few characters: minutes, hours, or days for its first week, then its day within the
 * current year, then only its year. A commit dated ahead of the clock shows as now.
 */
export function commitAge(authoredAt: number, now = new Date(), locales?: Intl.LocalesArgument) {
    let date = new Date(authoredAt * 1000)
    let minutes = (now.getTime() - date.getTime()) / 60_000
    return minutes < 1
        ? "now"
        : minutes < 60
        ? units("minute", minutes, locales)
        : minutes < 24 * 60
        ? units("hour", minutes / 60, locales)
        : minutes < 7 * 24 * 60
        ? units("day", minutes / (24 * 60), locales)
        : date.getFullYear() == now.getFullYear()
        ? new Intl.DateTimeFormat(locales, { month: "short", day: "numeric" }).format(date)
        : new Intl.DateTimeFormat(locales, { year: "numeric" }).format(date)
}

function units(unit: string, count: number, locales?: Intl.LocalesArgument) {
    return new Intl.NumberFormat(locales, { style: "unit", unit, unitDisplay: "narrow" }).format(Math.floor(count))
}
