# aiswitch

> ये script Switchboard app (`AiOrchestration`) के **CLI accounts** screen का engine है। App इसे `aiswitch json ...` से चलाता है। Terminal में `aiswitch` (menu) और बाकी commands भी पहले की तरह चलते हैं। Windows, macOS और Linux तीनों पर load होता है; limit पर auto-switch (`aiswitch run`) अभी सिर्फ macOS/Linux पर है।
>
> Limit का message दिखने पर aiswitch पहले provider से पक्का करता है कि limit सच में खत्म हुई है (Claude/Codex बोलें quota बचा है तो switch नहीं करता), फिर account को उसके असली reset time तक आराम देता है, अगला ready account लगाता है, session resume करता है और खुद `continue` टाइप कर देता है। हर switch `~/.aiswitch/events.json` और `~/.aiswitch/aiswitch.log` में लिखा जाता है।

`codex`, `claude` और `agy` CLI के कई accounts रखता है। जब किसी account की usage limit खत्म होती है, तो ये अपने आप अगले account पर switch करके session resume कर देता है।

## Setup (हर account के लिए एक बार)

सबसे आसान तरीका: terminal में `aiswitch` टाइप करो। Menu खुलेगा:
- `[a]` से account जोड़ो (login)
- `[s]` से auto-switch on करो

Menu के बिना, सीधे commands से:

```sh
aiswitch save codex acc1        # अभी जो account logged-in है, उसे "acc1" नाम से save करो
aiswitch add  codex acc2        # login साफ करो → codex खुलेगा → नए account से login करो → exit करो
aiswitch add  codex acc3
# claude और agy के लिए भी यही करो
aiswitch list
```

Login के बाद `add` अपने आप save कर देता है। पहले से logged-in account कभी नहीं खोता। उसे पहले save कर लिया जाता है, या `backup-<time>` नाम से रख दिया जाता है।

## रोज़ का इस्तेमाल

`~/.zshrc` में अपने पुराने aliases की जगह ये लिखो:

```sh
alias codex='aiswitch run codex'
alias claude='aiswitch run claude --dangerously-skip-permissions'
alias agy='aiswitch run agy --dangerously-skip-permissions'
```

इसके बाद `codex` / `claude` / `agy` पहले की तरह चलाओ। Limit का message आते ही aiswitch:
1. उस account को 5 घंटे के cooldown पर डाल देता है,
2. tool को बंद करता है, अगला ready account लगाता है,
3. फिर से चलाता है: `codex resume --last`, `claude --continue` या `agy --continue`। तुम्हारे flags बचे रहते हैं।

Manual commands: `aiswitch use <tool> <name>`, `aiswitch next <tool>`, `aiswitch reset <tool> [name]`.

## Usage देखना

`aiswitch` खोलते ही usage दिखता है। बाद में देखना हो तो menu में `[g]` दबाओ, या ये command चलाओ:

```sh
aiswitch usage                 # सब tools
aiswitch usage claude --days 30
aiswitch usage agy --fresh     # cache छोड़कर अभी का quota पूछो
```

| | Limits (बचा हुआ %, reset time) | Tokens (model के हिसाब से) |
|---|---|---|
| Claude | Live, हर account के token से। Token expire हो गया हो तो आखिरी बार देखा गया data | `~/.claude/projects` से। Account-wise सिर्फ उन switches के लिए जो aiswitch ने note किए |
| Codex | आखिरी session log से (कितनी देर पहले का है, ये भी दिखता है) | `~/.codex/sessions` से। हर session में account id लिखा होता है |
| agy | Live (`agy -p /usage`)। हर account के लिए कुछ seconds के लिए login बदलता है। कोई agy session खुली हो तो ये skip होता है | agy tokens का हिसाब नहीं रखता |

## Config

`~/.aiswitch/config.json` में हर tool के लिए default settings बदल सकते हो, जैसे:

```json
{ "agy": { "patterns": ["exact limit message from agy"], "cooldown_hours": 24 } }
```

## ध्यान देने वाली बातें

- **ToS:** limit से बचने के लिए accounts rotate करना OpenAI / Anthropic / Google की terms के खिलाफ है। Accounts ban हो सकते हैं।
- **agy के patterns अंदाज़े पर हैं।** जब पहली बार असली limit message दिखे, उसका exact text config में डाल दो।
- **False trigger:** अगर किसी tool के output में limit वाला वाक्य दिख जाए (जैसे AI ये file पढ़ रहा हो), तो switch हो सकता है। ऐसा हो तो `aiswitch reset <tool>` चलाओ।
- **Claude:** switch करने से उसी Mac पर चल रहे बाकी Claude Code sessions का account भी बदल जाता है, क्योंकि Keychain सब share करते हैं। Codex desktop app भी `~/.codex/auth.json` ही इस्तेमाल करता है।
- Tokens `~/.aiswitch/profiles` में plain files के रूप में रहते हैं (permission 0700/0600)। इस folder को कभी share या sync मत करना।
