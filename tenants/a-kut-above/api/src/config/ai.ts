import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { env } from './env';

export const claude = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
export const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });
