import { composeRenderProps } from "react-aria-components/composeRenderProps"
import { SelectionIndicator, Tab as RACTab, TabList as RACTabList, type TabListProps, TabPanel as RACTabPanel, type TabPanelProps, TabPanels as RACTabPanels, type TabPanelsProps, type TabProps, Tabs as RACTabs, type TabsProps } from "react-aria-components/Tabs"
import "./Tabs.css"

export function Tabs(props: TabsProps) {
    return <RACTabs {...props} />
}

export function TabList<T>(props: TabListProps<T>) {
    return <RACTabList {...props} />
}

export function Tab(props: TabProps) {
    return (
        <RACTab {...props}>
            {composeRenderProps(props.children, children => (
                <>
                    {children}
                    <SelectionIndicator />
                </>
            ))}
        </RACTab>
    )
}

export function TabPanels<T>(props: TabPanelsProps<T>) {
    return <RACTabPanels {...props} />
}

export function TabPanel(props: TabPanelProps) {
    return <RACTabPanel {...props} />
}
