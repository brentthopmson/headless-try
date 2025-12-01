// Function to send a message via Telegram to multiple chat IDs
export async function sendTelegramMessage(chatIds, message) {
  const chatIdArray = chatIds.split(","); // Split the chatIds by comma
  const token = process.env.TELEGRAM_BOT_TOKEN;

  for (const chatId of chatIdArray) {
    const payload = {
      chat_id: chatId.trim(), // Trim spaces if any
      text: message,
    };

    try {
      const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });
      const data = await response.json();
      console.log(`Telegram message sent to ${chatId}:`, data);
    } catch (error) {
      console.error(`Failed to send Telegram message to ${chatId}:`, error);
    }
  }
}
