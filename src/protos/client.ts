import * as path from "path";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";

const PROTO_PATH = path.join(__dirname, "service.proto");

const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
});

const proto: any = grpc.loadPackageDefinition(packageDefinition).owlbot;

const GRPC_SERVER_ADDRESS = process.env.GRPC_SERVER_ADDRESS || "localhost:50051";

const client = new proto.FileConverter(
    GRPC_SERVER_ADDRESS,
    grpc.credentials.createInsecure(),
    {
        "grpc.max_send_message_length": 100 * 1024 * 1024,
        "grpc.max_receive_message_length": 100 * 1024 * 1024,
    }
);

export interface ConvertFileResult {
    filename: string;
    markdown: string;
}

export function convertFileToMarkdown(filename: string, content: Buffer): Promise<ConvertFileResult> {
    return new Promise((resolve, reject) => {
        client.ConvertFile(
            { filename, content },
            (err: grpc.ServiceError | null, response: any) => {
                if (err) {
                    return reject(err);
                }
                resolve({ filename: response.filename, markdown: response.markdown });
            }
        );
    });
}

// ── Python code runner (owner-written agent functions) ──
const codeRunner = new proto.CodeRunner(
    GRPC_SERVER_ADDRESS,
    grpc.credentials.createInsecure(),
    {
        "grpc.max_send_message_length": 20 * 1024 * 1024,
        "grpc.max_receive_message_length": 20 * 1024 * 1024,
    }
);

export interface RunPythonResult {
    ok: boolean;
    result?: unknown;
    stdout: string;
    error?: string;
    durationMs: number;
}

// Runs `code` (which defines run(args, secrets)) in the Python gRPC service.
export function runPython(code: string, args: Record<string, unknown>, secrets: Record<string, string>, timeoutMs: number): Promise<RunPythonResult> {
    return new Promise((resolve, reject) => {
        codeRunner.RunPython(
            { code, args_json: JSON.stringify(args ?? {}), secrets_json: JSON.stringify(secrets ?? {}), timeout_ms: timeoutMs },
            // a little longer than the function's own timeout, for process start-up
            { deadline: Date.now() + timeoutMs + 15_000 },
            (err: grpc.ServiceError | null, res: any) => {
                if (err) {
                    const unavailable = err.code === grpc.status.UNAVAILABLE;
                    const unimplemented = err.code === grpc.status.UNIMPLEMENTED;
                    return reject(new Error(
                        unavailable ? `The Python service isn't reachable at ${GRPC_SERVER_ADDRESS} — start it (python_prac/owlbot).`
                            : unimplemented ? "The Python service is running an old version without the code runner — restart it."
                                : `Python service error: ${err.details || err.message}`
                    ));
                }
                let result: unknown = undefined;
                if (res.ok && res.result_json) {
                    try { result = JSON.parse(res.result_json); } catch { result = res.result_json; }
                }
                resolve({ ok: !!res.ok, result, stdout: res.stdout ?? "", error: res.error || undefined, durationMs: Number(res.duration_ms ?? 0) });
            }
        );
    });
}
