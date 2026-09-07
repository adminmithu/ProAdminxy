require('dotenv').config();
const { Telegraf } = require('telegraf');

const bot = new Telegraf(process.env.BOT_TOKEN);
const vercelDomain = process.argv[2] || process.env.VERCEL_URL || 'prime-oss.vercel.app';

async function setWebhook() {
    const cleanDomain = vercelDomain.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    const webhookUrl = `https://${cleanDomain}/api/bot.js`;
    console.log(`Setting Telegram Webhook to: ${webhookUrl}`);
    
    await bot.telegram.setMyCommands([
        { command: 'start', description: 'Start the bot / প্রধান মেনু 🚀' }
    ]);

    const res = await bot.telegram.setWebhook(webhookUrl, {
        allowed_updates: ['message', 'edited_message', 'channel_post', 'callback_query', 'inline_query', 'my_chat_member', 'chat_member']
    });
    console.log('SetWebhook Response:', res ? 'SUCCESS ✅' : 'FAILED ❌');

    const info = await bot.telegram.getWebhookInfo();
    console.log('Current Telegram Webhook Info:', JSON.stringify(info, null, 2));
}

setWebhook().catch(err => {
    console.error('Error setting webhook:', err.message);
    process.exit(1);
});
