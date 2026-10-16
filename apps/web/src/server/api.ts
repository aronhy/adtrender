import express,{type Request,type Response} from 'express';
import type { MiddlewareConfigFn } from 'wasp/server/middleware';
import { prisma } from 'wasp/server';
import { configuredBilling } from './operations';
import { DomainError } from '../team/access';
import { operationalHealth } from './health';

export async function health(_req:Request,res:Response,_context:unknown){
  const state=await operationalHealth(prisma);
  res.status(state.database==='ok'?200:503).json(state);
}
export const stripeMiddleware:MiddlewareConfigFn=config=>{
  config.delete('express.json');config.delete('express.urlencoded');
  config.set('stripe.raw',express.raw({type:'application/json',limit:'1mb'}));return config;
};
export async function stripeWebhook(req:Request,res:Response,_context:unknown){
  try {
    if(!Buffer.isBuffer(req.body)||typeof req.headers['stripe-signature']!=='string')return void res.status(400).json({error:'INVALID_WEBHOOK'});
    await configuredBilling().handleWebhook(req.body,req.headers['stripe-signature']);res.json({received:true});
  } catch(error) {
    res.status(error instanceof DomainError?error.status:500).json({error:error instanceof DomainError?error.code:'WEBHOOK_FAILED'});
  }
}
