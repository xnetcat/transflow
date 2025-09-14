// Test/development templates index. In production, the baked
// templates.index.cjs inside the Lambda image will be used instead.
module.exports = {
  "test-template": {
    default: {
      id: "test-template",
      webhookUrl: "https://example.com/webhook",
      webhookSecret: "test-secret",
      steps: [
        {
          name: "noop",
          run: async () => {},
        },
      ],
    },
  },
};
