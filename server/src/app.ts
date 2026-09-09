import express from'express';import cors from'cors';import cookieParser from'cookie-parser';import helmet from'helmet';import morgan from'morgan';import path from'node:path';import fs from'node:fs';import{fileURLToPath}from'node:url';import{ZodError}from'zod';import{api}from'./routes/index.js';import{ApiError}from'./utils/http.js';export const app=express();app.set('trust proxy',1);app.use(helmet());app.use(cors({origin:process.env.CLIENT_URL??'http://localhost:5173',credentials:true}));app.use(express.json({limit:'5mb',verify:(req,_res,buf)=>{(req as any).rawBody=buf;}}));app.use(cookieParser());app.use(morgan('dev'));app.get('/health',(_q,res)=>res.json({status:'ok'}));app.use('/api',api);
// On a persistent host (Render/Railway) one process serves both halves: the built SPA
// comes from the same origin as /api, which is what keeps the client's relative
// fetch('/api/...') calls, the Socket.IO handshake and the httpOnly `orbit_token`
// cookie working with no CORS or cross-site-cookie problems. Guarded on the build
// existing so local dev (client on :5173) still gets a JSON 404 for unknown routes.
const clientDist=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../client/dist');
if(fs.existsSync(path.join(clientDist,'index.html'))){
  // Vite fingerprints asset filenames, so they cache forever; index.html is served
  // below by sendFile instead, and must not be cached or deploys go unnoticed.
  app.use(express.static(clientDist,{maxAge:'1y',index:false}));
  // SPA fallback: client-side routes (/whatsapp, /leads, ...) return index.html, but an
  // unmatched /api path must fall through to the JSON 404 rather than be handed HTML.
  app.use((req,res,next)=>{if(req.method!=='GET'&&req.method!=='HEAD')return next();if(req.path.startsWith('/api/'))return next();res.sendFile(path.join(clientDist,'index.html'));});
}
app.use((_q,res)=>res.status(404).json({error:'Route not found'}));app.use((err:any,_q:express.Request,res:express.Response,_n:express.NextFunction)=>{if(err instanceof ZodError)return res.status(422).json({error:'Validation failed',details:err.issues});if(err instanceof ApiError)return res.status(err.status).json({error:err.message});if(err?.name==='ValidationError')return res.status(422).json({error:Object.values(err.errors??{}).map((x:any)=>x.message).join(', ')||'Validation failed'});if(err?.code===11000)return res.status(409).json({error:`A record with this ${Object.keys(err.keyPattern??{name:1})[0]} already exists`});if(err?.name==='CastError')return res.status(400).json({error:`Invalid value for ${err.path}`});if(err?.name==='JsonWebTokenError')return res.status(401).json({error:'Invalid session'});console.error(err);return res.status(500).json({error:'Internal server error'})});
