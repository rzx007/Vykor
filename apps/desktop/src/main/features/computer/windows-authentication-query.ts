// Shared by the semantic and foreground helpers before reading window values or pixels.
export const windowsAuthenticationQuery = String.raw`
public static class VykorWindowsAuthentication
{
    static readonly System.Text.RegularExpressions.Regex caption = new System.Text.RegularExpressions.Regex(
        @"windows security|user account control|secure desktop|\b(?:sign[- ]?in|log[- ]?in)\b|^\s*(?:password|passcode|credentials?)\s*$|windows 安全|用户帐户控制|身份验证|登录",
        System.Text.RegularExpressions.RegexOptions.IgnoreCase | System.Text.RegularExpressions.RegexOptions.CultureInvariant);
    static readonly System.Text.RegularExpressions.Regex field = new System.Text.RegularExpressions.Regex(
        @"password|passcode|credential|recovery[ _-]*(?:phrase|key|code)|(?:one[ _-]*time|authentication|verification|security|otp|2fa|mfa)[ _-]*code|\b(?:otp|2fa|mfa)\b|密码|口令|验证码|助记词|恢复(?:码|密钥)",
        System.Text.RegularExpressions.RegexOptions.IgnoreCase | System.Text.RegularExpressions.RegexOptions.CultureInvariant);

    public static bool SensitiveCaption(string text) {
        return !String.IsNullOrEmpty(text) && caption.IsMatch(text);
    }

    public static bool SensitiveField(bool isPassword, string name, string automationId, string helpText) {
        return isPassword || field.IsMatch(name ?? "") || field.IsMatch(automationId ?? "") || field.IsMatch(helpText ?? "");
    }

    public static bool RequiresHandoff(AutomationElement.AutomationElementInformation current) {
        if (current.IsPassword) return true;
        var role = current.ControlType;
        if (role == ControlType.Window || role == ControlType.Pane || role == ControlType.Group)
            return SensitiveCaption(current.Name);
        return (role == ControlType.Edit || role == ControlType.Document || role == ControlType.ComboBox ||
            role == ControlType.Custom) && SensitiveField(false, current.Name, current.AutomationId, current.HelpText);
    }

    public static bool Clear(AutomationElement element, ref int budget, int depth) {
        if (element == null || --budget < 0 || depth > 32 || RequiresHandoff(element.Current)) return false;
        var walker = TreeWalker.RawViewWalker;
        for (var child = walker.GetFirstChild(element); child != null; child = walker.GetNextSibling(child))
            if (!Clear(child, ref budget, depth + 1)) return false;
        return true;
    }
}
`
