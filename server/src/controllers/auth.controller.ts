import type { Request, Response } from 'express';
import bcrypt from 'bcryptjs'; import jwt from 'jsonwebtoken'; import mongoose from 'mongoose';
import { Role, User } from '../models/index.js'; import { ApiError } from '../utils/http.js';
const cookieOptions = () => ({ httpOnly:true, secure:process.env.NODE_ENV==='production', sameSite:'lax' as const, maxAge:8*60*60*1000 });
export async function login(req:Request,res:Response){const {email,password}=req.body;if(typeof email!=='string'||typeof password!=='string')throw new ApiError(422,'Email and password are required');const user=await User.findOne({email:email.toLowerCase(),active:true,deletedAt:{$exists:false}}).select('+password').populate('role');if(!user||!await bcrypt.compare(password,user.password))throw new ApiError(401,'Invalid email or password');const token=jwt.sign({sub:String(user._id)},process.env.JWT_SECRET!,{expiresIn:(process.env.JWT_EXPIRES_IN??'8h') as any});res.cookie('orbit_token',token,cookieOptions()).json({user:safe(user)});}
export async function signupAdmin(req:Request,res:Response){
  const {name,email,password,confirmPassword}=req.body;
  if(typeof name!=='string'||name.trim().length<2)throw new ApiError(422,'Name must contain at least 2 characters');
  if(typeof email!=='string'||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))throw new ApiError(422,'Enter a valid email address');
  if(typeof password!=='string'||password.length<8||!/[A-Z]/.test(password)||!/[a-z]/.test(password)||!/[0-9]/.test(password))throw new ApiError(422,'Password must be at least 8 characters and include upper-case, lower-case, and numeric characters');
  if(password!==confirmPassword)throw new ApiError(422,'Passwords do not match');
  if(await User.exists({}))throw new ApiError(403,'Administrator signup is disabled after workspace initialization');
  const lockCollection=mongoose.connection.collection('bootstrap_locks');
  try{await lockCollection.insertOne({_id:'initial-admin' as any,createdAt:new Date()});}catch{throw new ApiError(409,'Workspace initialization is already in progress');}
  try{
    const role=await Role.findOneAndUpdate({name:'Administrator'},{$setOnInsert:{permissions:['*'],active:true}},{new:true,upsert:true});
    const user=await User.create({name:name.trim(),email:email.toLowerCase(),password:await bcrypt.hash(password,12),role:role._id,active:true});
    res.status(201).json({message:'Administrator account created',user:{_id:user._id,name:user.name,email:user.email}});
  }catch(error){await lockCollection.deleteOne({_id:'initial-admin' as any});throw error;}
}
export function logout(_req:Request,res:Response){res.clearCookie('orbit_token',cookieOptions()).status(204).end();}
export function me(req:Request,res:Response){res.json({user:safe(req.user!)});}
const safe=(user:any)=>{const data=user.toObject?user.toObject():user;delete data.password;return data;};
