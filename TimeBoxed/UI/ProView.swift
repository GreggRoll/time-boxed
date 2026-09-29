import SwiftUI
import StoreKit

struct ProView: View {
    @Environment(\.dismiss) private var dismiss
    let proStore: ProStore
    @State private var showsPrivacyInfo = false

    private var privacyURL: URL? {
        guard let value = Bundle.main.object(forInfoDictionaryKey: "ProPrivacyPolicyURL") as? String,
              let url = URL(string: value), url.scheme == "https", url.host != nil else { return nil }
        return url
    }

    var body: some View {
        NavigationStack {
            ZStack {
                PlannerBackground()
                ScrollView {
                    VStack(alignment: .leading, spacing: 24) {
                        legalLinks
                        hero
                        VStack(alignment: .leading, spacing: 22) {
                            benefit("clock.arrow.circlepath", "Every day, within reach", "Revisit your saved time boxes with unlimited history access.")
                            benefit("calendar.badge.plus", "Take your plan with you", "Export time boxes to Apple Calendar and Reminders in a tap.")
                            benefit("heart", "Support an indie developer", "Help keep Time Boxed growing with thoughtful improvements.")
                        }
                        .padding(22)
                        .background(AppTheme.cardSurface, in: RoundedRectangle(cornerRadius: 24))

                        if proStore.isCheckingAccess {
                            ProgressView("Checking purchases…")
                        } else if proStore.hasPro {
                            Label(proStore.hasLifetime ? "Lifetime Pro is unlocked" : "Your Pro subscription is active", systemImage: "checkmark.seal.fill")
                                .font(.headline)
                                .foregroundStyle(AppTheme.accent)
                            Button("Continue planning") { dismiss() }
                                .buttonStyle(.borderedProminent)
                        } else {
                            purchaseOptions
                        }

                        if let message = proStore.message {
                            Text(message)
                                .font(.subheadline)
                                .accessibilityIdentifier("proPurchaseMessage")
                        }
                        footer
                    }
                    .foregroundStyle(AppTheme.primaryText)
                    .padding(24)
                    .frame(maxWidth: 560)
                    .frame(maxWidth: .infinity)
                }
            }
            .navigationTitle("Time Boxed Pro")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .task { await proStore.loadProducts() }
            .alert("Privacy Policy", isPresented: $showsPrivacyInfo) {
                Button("OK", role: .cancel) { }
            } message: {
                Text("The privacy policy link is not available in this build. Please check back before purchasing.")
            }
        }
        .tint(AppTheme.accent)
    }

    private var hero: some View {
        VStack(alignment: .leading, spacing: 12) {
            Image(systemName: "clock.badge.checkmark")
                .font(.system(size: 40))
                .foregroundStyle(AppTheme.accent)
                .accessibilityHidden(true)
            Text("Make room for\nevery day.")
                .font(.system(.largeTitle, design: .rounded, weight: .bold))
            Text("Your plans today. Your progress over time.")
                .font(.title3)
                .foregroundStyle(AppTheme.secondaryText)
        }
    }

    private var purchaseOptions: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Two ways to go Pro. All the same features.")
                .font(.headline)
            if proStore.isLoadingProducts {
                ProgressView("Loading prices…")
            }
            ForEach(ProStore.productIDs, id: \.self) { id in
                if let product = proStore.products.first(where: { $0.id == id }) {
                    purchaseButton(product)
                }
            }
            if proStore.products.count < ProStore.productIDs.count && !proStore.isLoadingProducts {
                Button("Retry loading prices") { Task { await proStore.loadProducts() } }
            }
            if proStore.isPurchasing { ProgressView("Contacting the App Store…") }
            Text("Monthly renews automatically until canceled. Lifetime is a one-time purchase with no renewal. Both include history and exports. Daily planning stays free.")
                .font(.footnote)
                .foregroundStyle(AppTheme.secondaryText)
        }
    }

    private func purchaseButton(_ product: Product) -> some View {
        let monthly = product.id == ProStore.monthlyID
        return Button {
            Task { await proStore.purchase(product) }
        } label: {
            VStack(alignment: .leading, spacing: 5) {
                Text(monthly ? "Subscribe monthly · \(product.displayPrice)/month" : "Unlock lifetime · \(product.displayPrice)")
                    .font(.system(.headline, design: .rounded))
                Text(monthly ? "Billed monthly. Cancel anytime." : "Pay once. Keep Pro forever.")
                    .font(.subheadline)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(12)
        }
        .buttonStyle(.borderedProminent)
        .disabled(proStore.isPurchasing || privacyURL == nil)
    }

    private var legalLinks: some View {
        VStack(alignment: .leading, spacing: 14) {
            Link("Terms of Use (EULA)", destination: URL(string: "https://www.apple.com/legal/internet-services/itunes/dev/stdeula/")!)
                .frame(minHeight: 44)
            if let privacyURL {
                Link("Privacy Policy", destination: privacyURL)
                    .frame(minHeight: 44)
            } else {
                Button("Privacy Policy") { showsPrivacyInfo = true }
                Text("Purchases will be available once the privacy policy is published.")
                    .font(.footnote)
                    .foregroundStyle(AppTheme.secondaryText)
            }
        }
        .font(.subheadline)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .background(AppTheme.cardSurface, in: RoundedRectangle(cornerRadius: 16))
    }

    private var footer: some View {
        VStack(alignment: .leading, spacing: 14) {
            Button("Restore Purchases") { Task { await proStore.restore() } }
                .disabled(proStore.isPurchasing)
            Link("Manage Subscription", destination: URL(string: "https://apps.apple.com/account/subscriptions")!)
            Text("Payment is charged to your Apple Account at confirmation. Monthly subscriptions renew automatically unless canceled at least 24 hours before the current period ends. Manage or cancel in your App Store account settings. Your saved days stay on this device if Pro access ends.")
                .font(.caption)
                .foregroundStyle(AppTheme.secondaryText)
        }
        .font(.subheadline)
    }

    private func benefit(_ symbol: String, _ title: String, _ detail: String) -> some View {
        HStack(alignment: .top, spacing: 14) {
            Image(systemName: symbol)
                .font(.title2)
                .foregroundStyle(AppTheme.accent)
                .frame(width: 30)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 5) {
                Text(title).font(.system(.headline, design: .rounded))
                Text(detail).font(.subheadline).foregroundStyle(AppTheme.secondaryText)
            }
        }
    }
}
