// Imported first by CLI scripts that drain the queue themselves: prevents the
// enqueue-triggered inline drain from racing with the script's own drain/close.
process.env.INLINE_WORKER ??= 'false';
