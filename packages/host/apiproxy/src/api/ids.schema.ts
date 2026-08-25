/** Branded identity schemas shared by the remaining API Proxy domains. */

import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { z } from 'zod'

/** Non-empty Session identity after transport validation. */
export const sessionIdSchema = z.string().min(1) as unknown as z.ZodType<SessionId>
