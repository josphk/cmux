// =============================================================================
// PATCH: Add "inspect" browser subcommand
// =============================================================================
// INSERT in CLI/cmux.swift
// LOCATION: Inside runBrowserCommand(), before the final
//           `throw CLIError(message: "Unsupported browser subcommand: \(subcommand)")`
//           (around line 3367), after the input_mouse/input_keyboard/input_touch block.
//
//     if ["input_mouse", "input_keyboard", "input_touch"].contains(subcommand) {
//         ...
//         return
//     }
//     // >>> INSERT HERE <<<
//     throw CLIError(message: "Unsupported browser subcommand: \(subcommand)")

        if subcommand == "inspect" {
            let sid = try requireSurface()

            let waitMode = hasFlag(subArgs, name: "--wait")
            let (timeoutMsOpt, rem1) = parseOption(subArgs, name: "--timeout-ms")
            let (timeoutSecOpt, _) = parseOption(rem1, name: "--timeout")

            var params: [String: Any] = ["surface_id": sid]

            if waitMode {
                params["wait"] = true
            }

            if let timeoutMsOpt {
                guard let ms = Int(timeoutMsOpt) else {
                    throw CLIError(message: "--timeout-ms must be an integer")
                }
                params["timeout_ms"] = ms
            } else if let timeoutSecOpt {
                guard let seconds = Double(timeoutSecOpt) else {
                    throw CLIError(message: "--timeout must be a number")
                }
                params["timeout_ms"] = max(1, Int(seconds * 1000.0))
            }

            let payload = try client.sendV2(method: "browser.inspect", params: params)

            if jsonOutput {
                print(jsonString(formatIDs(payload, mode: idFormat)))
            } else if waitMode {
                // In wait mode, print the picks as JSON for piping/scripting.
                if let picks = payload["picks"] as? [Any], !picks.isEmpty {
                    if JSONSerialization.isValidJSONObject(picks),
                       let data = try? JSONSerialization.data(withJSONObject: picks, options: [.prettyPrinted]),
                       let text = String(data: data, encoding: .utf8) {
                        print(text)
                    } else {
                        print(jsonString(payload))
                    }
                } else {
                    print("No elements picked.")
                }
            } else {
                let status = (payload["status"] as? String) ?? "OK"
                output(payload, fallback: "Inspection mode \(status)")
            }
            return
        }
