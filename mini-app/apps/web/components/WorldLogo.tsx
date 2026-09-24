// Artwork from Composite-Labs/frontend web/packages/ui-kit/src/icons/brand-icons/logo-icon.tsx.
import type { ComponentProps, ReactNode } from 'react'

export function WorldLogo(props: ComponentProps<'svg'>): ReactNode {
    return (
        <svg width="32" height="32" viewBox="0 0 300 300" {...props}>
            <path
                fill="#fff"
                d="M192 0a48 48 0 0 1 34 14l60 60a48 48 0 0 1 14 34v84q0 20-14 34l-60 60a48 48 0 0 1-34 14h-84q-20 0-34-14l-60-60a48 48 0 0 1-14-34v-84a48 48 0 0 1 14-34l60-60a48 48 0 0 1 34-14zm-30 276h13l35-63a38 38 0 0 0 5-19v-32h-53zm-77-82a38 38 0 0 0 5 19l35 63h13V162H85zm-61-2a24 24 0 0 0 7 17l60 60 5 4-27-49a62 62 0 0 1-8-30v-32H24zm215 2a62 62 0 0 1-8 30l-27 49 5-4 60-60a24 24 0 0 0 7-17v-30h-37zM96 27l-5 4-60 60a24 24 0 0 0-7 17v30h37v-32q0-16 8-30zm66 111h53v-32a38 38 0 0 0-5-19l-35-63h-13zm69-62a62 62 0 0 1 8 30v32h37v-30a24 24 0 0 0-7-17l-60-60-5-4zM90 87a38 38 0 0 0-5 19v32h53V24h-13z"
            />
        </svg>
    )
}
