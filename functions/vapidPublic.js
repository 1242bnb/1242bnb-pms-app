import { json } from './_push.js';
export const onRequest = ({ env }) => json({ key: env.VAPID_PUBLIC });
