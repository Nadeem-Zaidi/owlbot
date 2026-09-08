// import OpenAI from "openai";
// import { Chunk, IFilereader } from "../interfaces/ifilereader";
// import { IVectorDb } from "../llm/interfaces/vectordb/ivector";
// import { ILLM } from "../llm/interfaces/illm";


// export class GenerateEmbedding{
//     private fileReader:IFilereader;
//     private vectorDb:IVectorDb;
//     private llm:ILLM;

//     constructor(fileReader:IFilereader,vectorDb:IVectorDb,llm:ILLM){
//         this.fileReader=fileReader;
//         this.vectorDb=vectorDb;
//         this.llm=llm;
//     }

//     async generate_embeddings(){
//         for await (const chunk of this.fileReader.read_md_files()){
//             const text=`${chunk.heading} ${chunk.content}`.trim();
//             const vector=await this.llm.generateEmbedding!(text)
//             const id = crypto.randomUUID();
//             this.vectorDb.upsertChunk(id,vector,chunk)
//         }
//     }
// }