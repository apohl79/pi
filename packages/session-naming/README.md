# @earendil-works/pi-session-naming

Provides bounded and credential-aware normalization for provider-generated
session titles. The policy is pure and does not persist names or call a model;
the server runtime owns sampling, explicit-name precedence, race suppression,
and usage accounting.
