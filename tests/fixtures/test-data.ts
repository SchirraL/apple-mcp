export const TEST_DATA = {
	// Test phone number for all messaging and contact tests
	PHONE_NUMBER: "+1 9999999999",

	// Test contact data
	CONTACT: {
		name: "Test Contact Claude",
		phoneNumber: "+1 9999999999",
	},

	// Test mail data
	MAIL: {
		testSubject: "Claude MCP Test Email",
		testBody: "This is a test email sent by Claude MCP for testing purposes.",
		testEmailAddress: "test@example.com",
	},

	// Test web search data
	WEB_SEARCH: {
		testQuery: "OpenAI Claude AI assistant",
		expectedResultsCount: 1, // Minimum expected results
	},

	// Test maps data
	MAPS: {
		testLocation: {
			name: "Apple Park",
			address: "One Apple Park Way, Cupertino, CA 95014",
		},
		testGuideName: "Claude Test Guide",
		testDirections: {
			from: "Apple Park, Cupertino, CA",
			to: "Googleplex, Mountain View, CA",
		},
	},
} as const;

export type TestData = typeof TEST_DATA;
