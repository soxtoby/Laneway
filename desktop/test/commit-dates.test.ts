import { describe, expect, test } from "bun:test"
import { commitAge } from "../src/renderer/react/commit-dates"

let now = new Date(2026, 9, 21, 12, 0)

describe("commitAge", () => {
    test("counts whole minutes, hours, and days through a commit's first week", () => {
        let result = [1, 59.9, 60, 24 * 60 - 1, 24 * 60, 7 * 24 * 60 - 1].map(minutes => age(minutesAgo(minutes)))

        expect(result).toEqual(["1m", "59m", "1h", "23h", "1d", "6d"])
    })

    test("shows the day from a week old, and only the year once the commit is from an earlier year", () => {
        let result = [minutesAgo(7 * 24 * 60), seconds(new Date(2026, 0, 1, 0, 0)), seconds(new Date(2025, 11, 31, 23, 59))].map(age)

        expect(result).toEqual(["Oct 14", "Jan 1", "2025"])
    })

    test("shows an earlier year in the locale's own digits", () => {
        let result = commitAge(seconds(new Date(2025, 11, 31, 23, 59)), now, "ar-EG")

        expect(result).toBe("٢٠٢٥")
    })

    test("shows a commit under a minute old, or dated ahead of the clock, as now", () => {
        let result = [minutesAgo(0.9), minutesAgo(-90)].map(age)

        expect(result).toEqual(["now", "now"])
    })
})

function age(authoredAt: number) {
    return commitAge(authoredAt, now, "en-US")
}

function minutesAgo(minutes: number) {
    return seconds(now) - minutes * 60
}

function seconds(date: Date) {
    return date.getTime() / 1000
}
