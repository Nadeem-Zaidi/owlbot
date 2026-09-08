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