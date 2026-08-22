import type { PiSessionEvent, PiSessionFactory } from "./types.js";
export interface FakePiSessionScriptStep {
    delayMs?: number;
    event: PiSessionEvent;
}
export interface FakePiSessionFactoryOptions {
    script?: FakePiSessionScriptStep[];
    failWithMessage?: string;
}
export declare function createFakePiSessionFactory(options?: FakePiSessionFactoryOptions): PiSessionFactory;
//# sourceMappingURL=fake-session-factory.d.ts.map