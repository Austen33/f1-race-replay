def answer(question: str, live_context: dict) -> dict:
    """Headless adapter for the engineer chat.

    Tries to import helpers from the existing engineer_chat_window module.
    Falls back to a stub if the module is unavailable (e.g. missing API keys).
    """
    try:
        from src.insights.engineer_chat_window import (
            build_system_prompt,
            call_llm_with_fallback,
        )

        system = build_system_prompt(live_context)
        reply = call_llm_with_fallback(system=system, user=question)
        return {"reply": reply, "citations": []}
    except Exception as e:
        return {"reply": f"Chat unavailable: {e}", "citations": []}
