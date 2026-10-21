import { describe, expect, test } from "bun:test"
import { createAppController } from "../src/renderer/react/app-controller"
import { inspectionScenario } from "./renderer-fixtures"

describe("inspection file navigator", () => {
    test("needs a diff column, lasts while it moves to another list, and goes with it", async () => {
        let { sut, columnId } = await inspecting()
        let navigator = () => sut.snapshot().columns[columnId]!.diffColumn?.navigator

        sut.setNavigator(columnId, "compact")
        expect(sut.snapshot().columns[columnId]!.diffColumn).toBeUndefined()

        sut.openDiffColumn(columnId, "working-staged", "src/file.txt")
        await settle()
        sut.setNavigator(columnId, "compact")
        expect(navigator()).toBe("compact")
        sut.setNavigator(columnId, "collapsed")
        expect(navigator()).toBe("collapsed")

        // Choosing a file from the other Working Changes list moves the diff column there, still focused.
        sut.toggleDiff(columnId, "working-unstaged", "other.txt")
        await settle()
        expect(sut.snapshot().columns[columnId]!.diffColumn).toMatchObject({ group: "working-unstaged", navigator: "collapsed" })

        sut.setNavigator(columnId, undefined)
        expect(navigator()).toBeUndefined()

        sut.setNavigator(columnId, "compact")
        sut.closeAuxiliary(sut.snapshot().auxiliary[columnId]![0]!.id)
        sut.openDiffColumn(columnId, "working-staged", "src/file.txt")
        await settle()
        expect(navigator()).toBeUndefined()
    })
})

async function inspecting() {
    let controller = createAppController(inspectionScenario().api)
    await controller.start()
    await settle()
    return { sut: controller.inspection, columnId: controller.columns.snapshot().columns[0]!.id }
}

// Lets the controller's background reads run to their next await.
async function settle() {
    for (let turn = 0; turn < 10; turn++)
        await Promise.resolve()
}
