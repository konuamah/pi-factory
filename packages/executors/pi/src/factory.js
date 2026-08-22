export function createUnimplementedPiSessionFactory() {
    return {
        async create() {
            throw new Error("Pi session factory not wired. Inject a Pi SDK-backed sessionFactory into PiAgentExecutor.");
        },
    };
}
