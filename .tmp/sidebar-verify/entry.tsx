import { createRoot } from 'remix/ui'
import { WorkbenchApp } from '../../desktop/src/renderer/src/app'
import { inspectionScenario } from '../../desktop/test/renderer-fixtures'
const scenario = inspectionScenario()
const getState = scenario.api.getState
scenario.api.getState = async () => {
 const state = await getState()
 const original = state.workspace.repositories[0]
 state.workspace.repositories = ['BI', 'CivitSlide', 'DotNetDo', 'ClientShared'].map((name, i) => ({...original, id: i === 3 ? original.id : `sample-${i}`, path: `D:\\Source\\${name}`, ...(original.status === 'available' ? {info: {...original.info, mainWorktree: `D:\\Source\\${name}`, selectedWorktree: `D:\\Source\\${name}`}} : {})}))
 return state
}
createRoot(document.querySelector('#app')!).render(<WorkbenchApp api={scenario.api} />)
