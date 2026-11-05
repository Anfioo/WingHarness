export default {
  extends: ["@commitlint/config-conventional"],
  rules: {
    "type-enum": [
      2,
      "always",
      [
        "feat", // a new feature
        "fix", // a bug fix
        "docs", // documentation only
        "style", // formatting, no code behaviour change
        "refactor", // neither a feature nor a fix
        "perf", // performance
        "test", // tests
        "build", // build system or packaging
        "ci", // CI configuration and scripts
        "chore", // everything else
        "revert", // revert a previous commit
      ],
    ],
    "subject-case": [0], // non-Latin subjects have no case to check
    "subject-max-length": [2, "always", 100],
    "body-leading-blank": [2, "always"],
    "footer-leading-blank": [2, "always"],
  },
};
