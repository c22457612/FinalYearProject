const security = require("eslint-plugin-security");
const noUnsanitized = require("eslint-plugin-no-unsanitized");

module.exports = [
  {
    files: ["**/*.js"],
    ignores: ["node_modules/**"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "script"
    },
    plugins: {
      security,
      "no-unsanitized": noUnsanitized
    },
    rules: {
      // Baseline security rules
      ...security.configs.recommended.rules,

      // DOM XSS sink detection
      "no-unsanitized/method": "warn",
      "no-unsanitized/property": "warn"
    }
  }
];
