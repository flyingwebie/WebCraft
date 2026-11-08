# AI providers are called directly, not through a hosted gateway

WebCraft calls AI providers directly with each Workspace's AI key (OpenAI, Anthropic, Google, OpenRouter, or any OpenAI-compatible endpoint, which covers self-hosted models). WebCraft records the tokens and estimated cost of every call and enforces monthly caps itself. A hosted gateway would provide budgets for free, but a self-hosted Install should not need a third-party account to translate. Anyone who wants a gateway can still use OpenRouter or an OpenAI-compatible gateway as their provider.
