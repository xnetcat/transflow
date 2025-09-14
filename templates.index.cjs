// Mock template file for testing
module.exports = {
  "test-template": {
    default: {
      id: "test-template",
      webhookUrl: "https://example.com/webhook",
      webhookSecret: "test-secret",
      steps: [
        {
          name: "test-step",
          run: async () => {
            return {};
          },
        },
      ],
    },
  },
};
