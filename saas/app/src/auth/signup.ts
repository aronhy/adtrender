import { defineUserSignupFields } from 'wasp/auth/providers/types';
import { z } from 'zod';
const signup = z.object({ email: z.email() });
export const getEmailUserFields = defineUserSignupFields({
  email: data => {
    const email = signup.parse(data).email.toLowerCase().trim();
    return email;
  },
});
